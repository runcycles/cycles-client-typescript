/**
 * Background commit retry engine with exponential backoff.
 *
 * Durability model: every scheduled retry is journaled to disk first (see
 * `journal.ts`) and the entry is removed only on a terminal outcome, so
 * pending commits survive process restarts and are replayed the next time
 * an engine is created for the same identity. When a retried commit lands
 * after the reservation's grace period (the server answers
 * `RESERVATION_EXPIRED` and has already returned the reserved budget to
 * the pool), the engine falls back to `POST /v1/events` — the spec's
 * post-hoc direct-debit endpoint — so the spend is still recorded.
 *
 * Retry timers are ref'd, so a naturally-draining Node process waits for
 * in-flight retries (the event-loop equivalent of a bounded exit flush);
 * `process.exit()`, crashes, and signals are covered by the journal.
 */

import * as path from "node:path";
import type { CyclesConfig } from "./config.js";
import type { CyclesClient } from "./client.js";
import type { CyclesResponse } from "./response.js";
import {
  authFingerprint,
  CommitJournal,
  defaultJournalDir,
  type PendingCommitRecord,
} from "./journal.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PendingCommit {
  reservationId: string;
  commitBody?: Record<string, unknown>;
  eventFallbackBody?: Record<string, unknown>;
  mode: "commit" | "event";
  attempt: number;
  /**
   * Server-requested minimum delay (ms) before the next attempt, set from
   * a 429's Retry-After and consumed by the retry loop.
   */
  retryAfterMs?: number;
}

function extractErrorCode(response: CyclesResponse): string | undefined {
  const errorResp = response.getErrorResponse();
  if (errorResp?.error !== undefined) {
    return errorResp.error;
  }
  const raw = response.getBodyAttribute("error");
  return typeof raw === "string" ? raw : undefined;
}

// Journal replay must happen at most once per identity directory per
// process: the first engine created for a (server, principal) identity
// claims its subdirectory and replays surviving entries; later engines
// (and the claimer's own in-flight work) are excluded. Because the claim
// is scoped to the identity subdirectory — not the shared parent — an
// engine for one server/key can never block another identity's entries
// from replaying.
const claimedDirs = new Set<string>();

/** @internal — test use only. */
export function _resetReplayStateForTests(): void {
  claimedDirs.clear();
}

export class CommitRetryEngine {
  private readonly _enabled: boolean;
  private readonly _maxAttempts: number;
  private readonly _initialDelay: number;
  private readonly _multiplier: number;
  private readonly _maxDelay: number;
  private readonly _flushTimeout: number;
  private readonly _baseUrl: string;
  private readonly _journal: CommitJournal | undefined;
  private readonly _inFlight = new Set<Promise<void>>();
  private _client: CyclesClient | undefined;

  constructor(config: CyclesConfig) {
    this._enabled = config.retryEnabled;
    this._maxAttempts = config.retryMaxAttempts;
    this._initialDelay = config.retryInitialDelay;
    this._multiplier = config.retryMultiplier;
    this._maxDelay = config.retryMaxDelay;
    this._flushTimeout = config.retryFlushTimeout;
    this._baseUrl = config.baseUrl;
    if (config.journalEnabled) {
      const base = config.journalDir ?? defaultJournalDir();
      // Per-identity subdirectory: clients sharing a journal directory but
      // using different servers or principals must never replay each
      // other's records (a foreign record would 401/403 against the wrong
      // credential).
      this._journal = new CommitJournal(
        path.join(base, authFingerprint(config.baseUrl, config.apiKey, config.tenant)),
      );
    }
  }

  setClient(client: CyclesClient): void {
    this._client = client;
    this._maybeReplay();
  }

  schedule(
    reservationId: string,
    commitBody: Record<string, unknown>,
    eventFallbackBody?: Record<string, unknown>,
    retryAfterMs?: number,
  ): void {
    const pending: PendingCommit = {
      reservationId,
      commitBody,
      eventFallbackBody,
      mode: "commit",
      attempt: 0,
    };
    if (retryAfterMs !== undefined) {
      // A rate-limited first attempt passes its Retry-After along so the
      // first background retry honors the server's delay.
      pending.retryAfterMs = retryAfterMs;
    }
    this._submit(pending);
  }

  /** Deliver spend via POST /v1/events for a reservation that already expired. */
  scheduleEvent(reservationId: string, eventBody: Record<string, unknown>): void {
    this._submit({
      reservationId,
      eventFallbackBody: eventBody,
      mode: "event",
      attempt: 0,
    });
  }

  /**
   * Wait (bounded) for in-flight retries to finish. Anything still pending
   * when the timeout elapses stays journaled and replays on the next run.
   */
  async flush(timeoutMs?: number): Promise<void> {
    const timeout = timeoutMs ?? this._flushTimeout;
    if (timeout <= 0) return;
    const pending = [...this._inFlight];
    if (pending.length === 0) return;
    await Promise.race([Promise.allSettled(pending), delay(timeout)]);
  }

  private _submit(pending: PendingCommit): void {
    this._journalRecord(pending);
    if (!this._enabled) {
      if (this._journal) {
        console.warn(
          `[runcycles] Retry disabled; pending ${pending.mode} journaled for replay on next run: ${pending.reservationId}`,
        );
      } else {
        console.warn(
          `[runcycles] Retry and journal disabled, dropping failed ${pending.mode}: ${pending.reservationId}`,
        );
      }
      return;
    }
    this._spawn(pending);
  }

  private _spawn(pending: PendingCommit): void {
    const promise = this._retryLoop(pending).finally(() => {
      this._inFlight.delete(promise);
    });
    // The reference is held in _inFlight (awaitable via flush()); the loop
    // itself never rejects.
    this._inFlight.add(promise);
  }

  private _maybeReplay(): void {
    if (!this._enabled || !this._journal || !this._client) return;
    if (claimedDirs.has(this._journal.directory)) return;
    claimedDirs.add(this._journal.directory);
    const entries = this._journal.loadPending(this._baseUrl);
    if (entries.length > 0) {
      console.warn(
        `[runcycles] Replaying ${entries.length} journaled pending commit(s) from ${this._journal.directory}`,
      );
    }
    const nowMs = Date.now();
    for (const entry of entries) {
      const pending: PendingCommit = {
        reservationId: entry.reservationId,
        commitBody: entry.commitBody,
        eventFallbackBody: entry.eventFallbackBody,
        mode: entry.mode,
        attempt: 0,
      };
      // Restore a persisted Retry-After floor as a relative delay; a floor
      // already in the past falls back to normal backoff.
      if (entry.notBeforeMs !== undefined && entry.notBeforeMs > nowMs) {
        pending.retryAfterMs = entry.notBeforeMs - nowMs;
      }
      this._spawn(pending);
    }
  }

  private _journalRecord(pending: PendingCommit): void {
    if (!this._journal) return;
    const record: PendingCommitRecord = {
      reservationId: pending.reservationId,
      baseUrl: this._baseUrl,
      mode: pending.mode,
      commitBody: pending.commitBody,
      eventFallbackBody: pending.eventFallbackBody,
      recordedAtMs: Date.now(),
    };
    if (pending.retryAfterMs !== undefined) {
      record.notBeforeMs = Date.now() + pending.retryAfterMs;
    }
    this._journal.record(record);
  }

  private _journalDiscard(reservationId: string): void {
    this._journal?.discard(reservationId);
  }

  private _delayFor(pending: PendingCommit): number {
    let backoff = Math.min(
      this._initialDelay * this._multiplier ** pending.attempt,
      this._maxDelay,
    );
    if (pending.retryAfterMs !== undefined) {
      // A 429 asked us to wait: honor the server's Retry-After when it
      // exceeds our own backoff, then clear it — it applies once.
      backoff = Math.max(backoff, pending.retryAfterMs);
      pending.retryAfterMs = undefined;
    }
    return backoff;
  }

  /** Detect 429 / LIMIT_EXCEEDED and stash its Retry-After. Transient, never terminal. */
  private _isRateLimited(pending: PendingCommit, response: CyclesResponse): boolean {
    if (response.status !== 429 && extractErrorCode(response) !== "LIMIT_EXCEEDED") {
      return false;
    }
    const retryAfterMs = response.retryAfterMsHeader;
    if (retryAfterMs !== undefined) {
      pending.retryAfterMs = retryAfterMs;
      // Persist the floor: a restart during a long Retry-After wait must
      // not replay into the window the server told us to avoid.
      this._journalRecord(pending);
    }
    console.warn(
      `[runcycles] ${pending.mode} retry rate-limited: ${pending.reservationId}, attempt=${pending.attempt}, retryAfterMs=${String(retryAfterMs)}`,
    );
    return true;
  }

  private async _retryLoop(pending: PendingCommit): Promise<void> {
    while (pending.attempt < this._maxAttempts) {
      const backoff = this._delayFor(pending);
      pending.attempt++;
      await delay(backoff);

      try {
        if (!this._client) {
          console.error(
            `[runcycles] No client set on retry engine, cannot retry ${pending.mode}`,
          );
          return;
        }
        if (await this._attemptOnce(pending)) {
          return;
        }
      } catch {
        // Transport exception — continue retrying.
      }
    }

    console.error(
      `[runcycles] ${pending.mode} retry exhausted after ${this._maxAttempts} attempts for reservation ${pending.reservationId}${this._journal ? " (journal entry retained for replay on next run)" : ""}`,
    );
  }

  /** Returns true when the outcome is terminal. */
  private async _attemptOnce(pending: PendingCommit): Promise<boolean> {
    if (pending.mode === "commit") {
      const response = await (this._client as CyclesClient).commitReservation(
        pending.reservationId,
        pending.commitBody ?? {},
      );
      const terminal = this._classifyCommitResponse(pending, response);
      // _classifyCommitResponse may flip the mode to "event" (expired →
      // deliver the event fallback immediately, no extra backoff); the cast
      // is needed because TS cannot see the mutation through the call.
      if (!terminal && (pending.mode as string) === "event") {
        return this._attemptOnce(pending);
      }
      return terminal;
    }
    const response = await (this._client as CyclesClient).createEvent(
      pending.eventFallbackBody ?? {},
    );
    return this._classifyEventResponse(pending, response);
  }

  /**
   * Handle a commit attempt's response. Returns true when terminal.
   * May flip `pending` into event mode; the caller then delivers the event
   * fallback immediately (no extra backoff).
   */
  private _classifyCommitResponse(
    pending: PendingCommit,
    response: CyclesResponse,
  ): boolean {
    if (response.isSuccess) {
      this._journalDiscard(pending.reservationId);
      return true;
    }
    if (this._isRateLimited(pending, response)) {
      return false;
    }
    if (response.status === 401 || response.status === 403) {
      console.error(
        `[runcycles] Commit retry got authentication failure (status=${response.status}); journal entry retained — fix credentials and restart to replay: ${pending.reservationId}`,
      );
      return true;
    }
    if (response.isClientError) {
      const code = extractErrorCode(response);
      if (code === "RESERVATION_EXPIRED") {
        if (pending.eventFallbackBody) {
          console.warn(
            `[runcycles] Reservation expired before commit landed; falling back to POST /v1/events: ${pending.reservationId}`,
          );
          pending.mode = "event";
          pending.attempt = 0;
          this._journalRecord(pending);
          return false;
        }
        console.error(
          `[runcycles] Reservation expired with no event fallback; spend is unrecorded (journal entry retained): ${pending.reservationId}`,
        );
        return true;
      }
      console.warn(
        `[runcycles] Commit retry got non-retryable error: ${pending.reservationId}, status=${response.status}, error=${String(code)}`,
      );
      this._journalDiscard(pending.reservationId);
      return true;
    }
    return false;
  }

  /** Handle an event-fallback attempt's response. Returns true when terminal. */
  private _classifyEventResponse(
    pending: PendingCommit,
    response: CyclesResponse,
  ): boolean {
    if (response.isSuccess) {
      this._journalDiscard(pending.reservationId);
      return true;
    }
    if (this._isRateLimited(pending, response)) {
      return false;
    }
    if (response.status === 401 || response.status === 403) {
      console.error(
        `[runcycles] Event fallback got authentication failure (status=${response.status}); journal entry retained — fix credentials and restart to replay: ${pending.reservationId}`,
      );
      return true;
    }
    if (response.isClientError) {
      console.error(
        `[runcycles] Event fallback rejected (${String(extractErrorCode(response))}); spend recovery failed: ${pending.reservationId}, status=${response.status}`,
      );
      this._journalDiscard(pending.reservationId);
      return true;
    }
    return false;
  }
}
