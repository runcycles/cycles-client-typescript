/**
 * First-class streaming adapter for Cycles budget governance.
 *
 * Unlike `withCycles` (which wraps a Promise-returning function and commits
 * immediately after the function resolves), `reserveForStream` returns a
 * handle that lets the caller control when to commit or release. This is
 * essential for LLM streaming where the function returns a stream object
 * immediately but actual usage is only known after the stream finishes.
 *
 * The handle owns its own finalization: calling `commit()` or `release()`
 * automatically stops the heartbeat. There is no need for a `finally`
 * block around the stream — the heartbeat lives until a terminal
 * operation (commit/release) is reached.
 *
 * RACE SAFETY: In real streaming code, multiple terminal paths can fire
 * concurrently (onFinish, error handler, abort signal, client disconnect).
 * The handle is once-only: the first terminal call (commit/release/dispose)
 * wins, and subsequent calls are either no-ops (release, dispose) or throw
 * (commit). Check `handle.finalized` to inspect state.
 *
 * Typical lifecycle:
 *   1. `reserveForStream(...)` — creates reservation + starts heartbeat
 *   2. Start streaming (e.g. `streamText(...)`)
 *   3. On stream finish → `handle.commit(actualCost, metrics)` (stops heartbeat)
 *   4. On stream error/abort → `handle.release("aborted")` (stops heartbeat)
 *   5. If stream startup fails before streaming begins → `handle.dispose()`
 */

import { randomUUID } from "node:crypto";
import type { CyclesClient } from "./client.js";
import { DEFAULT_TTL_MS } from "./constants.js";
import { buildProtocolException } from "./errors.js";
import { CyclesError, CyclesProtocolError } from "./exceptions.js";
import {
  buildEventFallbackBody,
  extractExtendErrorCode,
  PERMANENT_EXTEND_ERROR_CODES,
} from "./lifecycle.js";
import {
  metricsToWire,
  reservationCreateResponseFromWire,
} from "./mappers.js";
import type { CyclesResponse } from "./response.js";
import { CommitRetryEngine } from "./retry.js";
import type { Caps, CyclesMetrics, Decision, Subject } from "./models.js";
import { ErrorCode, errorCodeFromString, isMetricsEmpty } from "./models.js";
import {
  validateExtendByMs,
  validateGracePeriodMs,
  validateNonNegative,
  validateSubject,
  validateTtlMs,
} from "./validation.js";

export interface StreamReservationOptions {
  client: CyclesClient;
  estimate: number;
  unit?: string;
  actionKind?: string;
  actionName?: string;
  actionTags?: string[];
  ttlMs?: number;
  gracePeriodMs?: number;
  overagePolicy?: string;
  tenant?: string;
  workspace?: string;
  app?: string;
  workflow?: string;
  agent?: string;
  toolset?: string;
  dimensions?: Record<string, string>;
}

export interface StreamReservation {
  /** The reservation ID from the server. */
  readonly reservationId: string;
  /** The budget decision (ALLOW or ALLOW_WITH_CAPS). */
  readonly decision: Decision;
  /** Caps imposed by the budget, if any. */
  readonly caps: Caps | undefined;
  /** True after commit(), release(), or dispose() has been called. */
  readonly finalized: boolean;

  /**
   * Commit actual usage after the stream completes successfully.
   * Automatically stops the heartbeat. Call from `onFinish` or equivalent.
   * Throws `CyclesError` if the handle is already finalized.
   *
   * Durability: transient failures (transport/5xx/429), authentication
   * failures, post-expiry commits, and unclassifiable client errors
   * (codeless or unrecognized error codes) are handled internally —
   * journaled and retried in the background (with a `POST /v1/events`
   * fallback once the reservation has expired) — and resolve normally.
   * Only genuine rejections carrying a recognized protocol error code
   * (e.g. UNIT_MISMATCH) reset `finalized` and throw.
   */
  commit(
    actual: number,
    metrics?: CyclesMetrics,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Release the reservation on error or abort.
   * Automatically stops the heartbeat. Best-effort — errors are swallowed.
   * No-op if the handle is already finalized.
   */
  release(reason?: string): Promise<void>;

  /**
   * Stop the heartbeat timer without committing or releasing.
   * Use only for stream startup failures where the stream was never started.
   * For normal finalization, use `commit()` or `release()` instead.
   * No-op if the handle is already finalized.
   */
  dispose(): void;
}

/**
 * Reserve budget for a streaming operation and return a handle to
 * commit or release when the stream completes.
 *
 * Throws `BudgetExceededError` (or other protocol errors) if the
 * reservation is denied.
 */
export async function reserveForStream(
  options: StreamReservationOptions,
): Promise<StreamReservation> {
  const {
    client,
    estimate,
    unit = "USD_MICROCENTS",
    actionKind = "unknown",
    actionName = "unknown",
    actionTags,
    ttlMs = DEFAULT_TTL_MS,
    gracePeriodMs,
    overagePolicy = "ALLOW_IF_AVAILABLE",
    dimensions,
  } = options;

  validateNonNegative(estimate, "estimate");
  validateTtlMs(ttlMs);
  validateGracePeriodMs(gracePeriodMs);

  // Build subject from options, falling back to client config defaults
  const configDefaults = client.config;
  const subject: Record<string, unknown> = {};
  for (const field of ["tenant", "workspace", "app", "workflow", "agent", "toolset"] as const) {
    const val = options[field] ?? configDefaults[field];
    if (val) {
      subject[field] = val;
    }
  }
  if (dimensions) {
    subject.dimensions = dimensions;
  }
  validateSubject(subject as Subject);

  // Build action
  const action: Record<string, unknown> = { kind: actionKind, name: actionName };
  if (actionTags) {
    action.tags = actionTags;
  }

  // Build wire-format request body
  const body: Record<string, unknown> = {
    idempotency_key: randomUUID(),
    subject,
    action,
    estimate: { unit, amount: estimate },
    ttl_ms: ttlMs,
    overage_policy: overagePolicy,
  };
  if (gracePeriodMs !== undefined) {
    body.grace_period_ms = gracePeriodMs;
  }

  // Create reservation
  const response = await client.createReservation(body);
  if (!response.isSuccess) {
    throw buildProtocolException("Failed to create reservation", response);
  }

  const parsed = reservationCreateResponseFromWire(
    response.body as Record<string, unknown>,
  );

  if (parsed.decision === "DENY") {
    throw buildProtocolException("Reservation denied", response);
  }

  const reservationId = parsed.reservationId;
  if (!reservationId) {
    throw new CyclesProtocolError(
      "Reservation successful but reservation_id missing",
      { status: response.status },
    );
  }

  // Background retry engine: commit failures that represent real spend
  // (transient errors, auth failures, post-expiry commits) are journaled
  // and retried rather than surfaced as caller-managed exceptions.
  const retryEngine = new CommitRetryEngine(client.config);
  retryEngine.setClient(client);

  // Heartbeat and finalization state
  let heartbeatStopped = false;
  let finalized = false;
  let currentTimer: ReturnType<typeof setTimeout> | undefined;

  const stopHeartbeat = (): void => {
    if (!heartbeatStopped) {
      heartbeatStopped = true;
      clearTimeout(currentTimer);
    }
  };

  const startHeartbeat = (): void => {
    if (ttlMs <= 0) return;
    validateExtendByMs(ttlMs);
    // The FIRST beat fires IMMEDIATELY (delay 0). Tenant policy
    // max_reservation_ttl_ms may have silently capped the granted TTL far
    // below the requested one (governance default: 1 hour), the create
    // response has no effective-TTL field, and spec review round 4
    // confirmed that ANY bounded first-beat delay can outlive a small
    // capped lease — so the first extend primes the lease with a real,
    // measurable grant right away instead of gambling on an unknowable
    // one. After each applied grant the cadence re-derives from the
    // MEASURED grant: clamp(grant/2, 500, ttl/2), except under a lead
    // clamp (see the regime split in the success handler), where it holds
    // at min(ttl/2, 30 s). The 500 ms floor cannot starve liveness — it
    // binds only when the server grants less than 1 s per extend, i.e.
    // below the spec's own minimum ttl_ms.
    const heldIntervalMs = Math.min(ttlMs / 2, 30_000);
    let intervalMs = heldIntervalMs;

    // Lead lower-bound extension. `extend_by_ms` extends relative to the
    // CURRENT expires_at_ms (spec), so blindly extending by ttlMs on
    // every beat would drift expiry outward per beat and burn the
    // server's max_extensions budget faster than needed. Each beat
    // instead computes a rigorous LOWER BOUND on the expiry lead:
    //
    //   leadMin = grantsSum - (now - anchor)
    //
    // where grants are differences of SUCCESSIVE expires_at_ms values
    // returned by the server (same server clock frame) and the elapsed
    // term is client-monotonic — no cross-clock arithmetic anywhere.
    // leadMin starts at 0: the initial grant is deliberately NOT counted,
    // because there is no safe same-clock anchor to measure it against
    // (per RFC 9110 the HTTP Date header is a whole-second, best-effort
    // origination time that intermediaries may replace; in the reference
    // server expires_at_ms comes from Redis TIME while Date comes from
    // the servlet container). So leadMin never overstates the real lead.
    // A beat is skipped only when leadMin >= 1.5x the last MEASURED
    // grant; otherwise it extends by the requested ttl. When a response
    // carries no numeric expires_at_ms, the grant falls back to the
    // requested ttl (2xx is proof the extend applied).
    let prevExpiry = parsed.expiresAtMs;
    const anchor = performance.now();
    let grantsSum = 0;
    let lastGrant: number | undefined;
    // Monotonic time of the last APPLIED extend (heartbeat start before
    // the first one) — the baseline for the lead-clamp regime test.
    let lastSuccessMono: number | undefined;
    let leadClampWarned = false;
    // Idempotency key of an extend whose outcome we never saw. It is
    // reused on the retry so a lost response cannot double-extend.
    let pendingKey: string | undefined;

    const tick = (delayMs: number): void => {
      if (heartbeatStopped) return;
      currentTimer = setTimeout(() => {
        if (heartbeatStopped) return;
        const leadMin = grantsSum - (performance.now() - anchor);
        if (lastGrant !== undefined && leadMin >= 1.5 * lastGrant) {
          // Plenty of proven lead — skip this beat (no server call).
          tick(intervalMs);
          return;
        }
        const key = pendingKey ?? randomUUID();
        pendingKey = key;
        const extendBody = { idempotency_key: key, extend_by_ms: ttlMs };
        void client
          .extendReservation(reservationId, extendBody)
          .then((response) => {
            if (response.isSuccess) {
              // Any 2xx counts as applied — its expires_at_ms is
              // authoritative proof — even if the status field looks odd.
              pendingKey = undefined;
              const status = response.getBodyAttribute("status");
              if (typeof status === "string" && status !== "ACTIVE") {
                console.warn(
                  `[runcycles] Heartbeat extend returned 2xx with unexpected status "${status}"; treating as applied: ${reservationId}`,
                );
              }
              const newExpires = response.getBodyAttribute("expires_at_ms");
              // Measured server-frame grant; requested-ttl fallback when
              // either endpoint of the difference is unavailable.
              const grant =
                typeof newExpires === "number" &&
                typeof prevExpiry === "number"
                  ? newExpires - prevExpiry
                  : ttlMs;
              prevExpiry =
                typeof newExpires === "number"
                  ? newExpires
                  : prevExpiry !== undefined
                    ? prevExpiry + ttlMs
                    : undefined;
              const now = performance.now();
              const elapsedSinceSuccess = now - (lastSuccessMono ?? anchor);
              lastSuccessMono = now;
              // Regime split (spec review round 4). Under a maximum-LEAD
              // clamp the server holds expires_at_ms ~ now + L, so the
              // difference of successive expires_at_ms values measures
              // ELAPSED TIME, not granted lease — deriving the cadence
              // from it would collapse the interval to the floor and burn
              // max_extensions in seconds. A grant is treated as
              // lead-clamped when it is non-positive (no lease movement)
              // or both well below the requested ttl AND explainable as
              // elapsed time (<= 1.25x the time since the last applied
              // extend). Only a REAL per-extend grant may tighten the
              // cadence.
              if (
                grant <= 0 ||
                (grant < 0.9 * ttlMs && grant <= 1.25 * elapsedSinceSuccess)
              ) {
                // Hold the cadence — never tighten it — and keep
                // extending every beat: lastGrant ~ elapsed keeps leadMin
                // below the skip threshold, which is exactly the desired
                // behavior under a lead clamp.
                intervalMs = heldIntervalMs;
                if (!leadClampWarned) {
                  leadClampWarned = true;
                  console.warn(
                    `[runcycles] Server appears to clamp lease lead (extend moved expires_at_ms by ${grant}ms in ${Math.round(elapsedSinceSuccess)}ms); holding heartbeat cadence at ${heldIntervalMs}ms — the extension budget (max_extensions) will deplete: ${reservationId}`,
                  );
                }
              } else {
                intervalMs = Math.min(Math.max(grant / 2, 500), ttlMs / 2);
              }
              grantsSum += Math.max(grant, 0);
              lastGrant = Math.max(grant, 0);
              return;
            }
            // Failure: KEEP pendingKey so the next beat retries with the
            // same idempotency key. Permanent rejections (reservation gone,
            // settled, or extension budget exhausted) stop the heartbeat —
            // no retry can ever fix them. The bare status check catches
            // bodyless 410 Gone responses.
            const errorCode = extractExtendErrorCode(response);
            if (
              response.status === 410 ||
              (errorCode !== undefined &&
                PERMANENT_EXTEND_ERROR_CODES.has(errorCode))
            ) {
              console.warn(
                `[runcycles] Heartbeat extend permanently rejected (status=${response.status}, error=${String(errorCode)}); stopping heartbeat: ${reservationId}`,
              );
              heartbeatStopped = true;
              return;
            }
            console.warn(
              `[runcycles] Heartbeat extend failed (status=${response.status}); retrying next beat: ${reservationId}`,
            );
          })
          .catch(() => {
            // Transport error: best-effort — retry next beat, same key.
          })
          .finally(() => { tick(intervalMs); });
      }, delayMs);
    };

    // Immediate first beat — see the comment above heldIntervalMs. The
    // 0 delay applies to this first schedule ONLY: every reschedule (in
    // .finally and on skip) passes intervalMs, which starts at
    // heldIntervalMs and never becomes 0 — so a transient failure on the
    // immediate first attempt waits a full held interval before the
    // retry instead of hot-looping against a down server.
    tick(0);
  };

  startHeartbeat();

  return {
    reservationId,
    decision: parsed.decision as Decision,
    caps: parsed.caps,

    get finalized(): boolean {
      return finalized;
    },

    async commit(
      actual: number,
      metrics?: CyclesMetrics,
      metadata?: Record<string, unknown>,
    ): Promise<void> {
      if (finalized) {
        throw new CyclesError("StreamReservation already finalized");
      }
      finalized = true;
      stopHeartbeat();
      const commitBody: Record<string, unknown> = {
        idempotency_key: randomUUID(),
        actual: { unit, amount: actual },
      };
      if (metrics && !isMetricsEmpty(metrics)) {
        commitBody.metrics = metricsToWire(metrics);
      }
      if (metadata) {
        commitBody.metadata = metadata;
      }
      const eventFallback = buildEventFallbackBody(
        reservationId,
        subject,
        action,
        commitBody,
      );

      let response: CyclesResponse;
      try {
        response = await client.commitReservation(reservationId, commitBody);
      } catch {
        // Transport exception: the spend already happened — journal and
        // retry in the background rather than punting to the caller.
        retryEngine.schedule(reservationId, commitBody, eventFallback);
        return;
      }
      if (response.isSuccess) {
        return;
      }
      if (response.isTransportError || response.isServerError) {
        retryEngine.schedule(reservationId, commitBody, eventFallback);
        return;
      }

      const errorResp = response.getErrorResponse();
      let errorCode = errorResp?.error;
      if (errorCode === undefined) {
        const rawError = response.getBodyAttribute("error");
        if (typeof rawError === "string") {
          errorCode = rawError;
        }
      }

      if (response.status === 429 || errorCode === "LIMIT_EXCEEDED") {
        // Rate-limited, not rejected — never release spent budget.
        retryEngine.schedule(
          reservationId,
          commitBody,
          eventFallback,
          response.retryAfterMsHeader,
        );
        return;
      }
      if (response.status === 401 || response.status === 403) {
        console.error(
          `[runcycles] Stream commit got authentication failure (status=${response.status}); journaling for replay: ${reservationId}`,
        );
        retryEngine.schedule(reservationId, commitBody, eventFallback);
        return;
      }
      if (response.status === 410 || errorCode === "RESERVATION_EXPIRED") {
        // The status check catches bodyless 410 Gone responses.
        console.warn(
          `[runcycles] Reservation expired before commit; recovering spend via POST /v1/events: ${reservationId}`,
        );
        retryEngine.scheduleEvent(reservationId, eventFallback);
        return;
      }
      if (
        errorCode === "RESERVATION_FINALIZED" ||
        errorCode === "IDEMPOTENCY_MISMATCH"
      ) {
        console.warn(
          `[runcycles] Stream commit already settled (${errorCode}): ${reservationId}`,
        );
        return;
      }

      if (
        response.isClientError &&
        errorCode !== undefined &&
        errorCodeFromString(errorCode) !== ErrorCode.UNKNOWN
      ) {
        // Genuine rejection (e.g. UNIT_MISMATCH — a recognized protocol
        // code): reset finalized so the caller can correct and retry
        // commit or fall back to release. The heartbeat is NOT restarted
        // to avoid spawning duplicate heartbeat chains (an old in-flight
        // extend's .finally→tick could race with a new startHeartbeat
        // call). The reservation's remaining TTL should give the caller
        // enough time to retry or release.
        finalized = false;
        throw new CyclesError(
          `Commit failed with status ${response.status}: ${response.errorMessage ?? "unknown error"}`,
        );
      }

      // Codeless, mangled, or forward-compat unknown client error:
      // unclassifiable. Never throw away real spend on a response we
      // cannot interpret — journal it for background retry / replay.
      console.error(
        `[runcycles] Stream commit got unclassifiable client error (status=${response.status}, error=${String(errorCode)}); journaling for replay: ${reservationId}`,
      );
      retryEngine.schedule(reservationId, commitBody, eventFallback);
    },

    async release(reason?: string): Promise<void> {
      if (finalized) return;
      finalized = true;
      stopHeartbeat();
      try {
        const releaseBody = { idempotency_key: randomUUID(), reason: reason ?? "stream_aborted" };
        await client.releaseReservation(reservationId, releaseBody);
      } catch {
        // Best-effort release
      }
    },

    dispose(): void {
      if (finalized) return;
      finalized = true;
      stopHeartbeat();
    },
  };
}
