/** Lifecycle orchestration: reserve -> execute -> commit/release. */

import { randomUUID } from "node:crypto";
import type { CyclesClient } from "./client.js";
import { runWithContext, type CyclesContext } from "./context.js";
import { DEFAULT_TTL_MS } from "./constants.js";
import { buildProtocolException } from "./errors.js";
import { CyclesProtocolError } from "./exceptions.js";
import {
  metricsToWire,
  reservationCreateResponseFromWire,
} from "./mappers.js";
import {
  ErrorCode,
  errorCodeFromString,
  isMetricsEmpty,
  type CyclesMetrics,
  type Decision,
  type Subject,
} from "./models.js";
import type { CommitRetryEngine } from "./retry.js";
import {
  validateExtendByMs,
  validateGracePeriodMs,
  validateNonNegative,
  validateSubject,
  validateTtlMs,
} from "./validation.js";

export interface WithCyclesConfig<
  TArgs extends unknown[] = unknown[],
  TResult = unknown,
> {
  estimate: number | ((...args: TArgs) => number);
  actual?: number | ((result: TResult) => number);
  actionKind?: string | ((...args: TArgs) => string | undefined);
  actionName?: string | ((...args: TArgs) => string | undefined);
  actionTags?: string[];
  unit?: string;
  ttlMs?: number;
  gracePeriodMs?: number;
  overagePolicy?: string;
  dryRun?: boolean;
  tenant?: string | ((...args: TArgs) => string | undefined);
  workspace?: string | ((...args: TArgs) => string | undefined);
  app?: string | ((...args: TArgs) => string | undefined);
  workflow?: string | ((...args: TArgs) => string | undefined);
  agent?: string | ((...args: TArgs) => string | undefined);
  toolset?: string | ((...args: TArgs) => string | undefined);
  dimensions?: Record<string, string>;
  useEstimateIfActualNotProvided?: boolean;
}

interface SubjectDefaults {
  tenant?: string;
  workspace?: string;
  app?: string;
  workflow?: string;
  agent?: string;
  toolset?: string;
}

function evaluateAmount(
  expr: number | ((...args: unknown[]) => number),
  args: unknown[],
): number {
  if (typeof expr === "function") {
    return expr(...args);
  }
  return expr;
}

function evaluateActual(
  expr: number | ((result: unknown) => number) | undefined,
  result: unknown,
  estimate: number,
  useEstimateFallback: boolean,
): { amount: number; usedEstimateFallback: boolean } {
  if (expr !== undefined) {
    if (typeof expr === "function") {
      return { amount: expr(result), usedEstimateFallback: false };
    }
    return { amount: expr, usedEstimateFallback: false };
  }
  if (useEstimateFallback) {
    return { amount: estimate, usedEstimateFallback: true };
  }
  throw new Error(
    "actual expression is required when useEstimateIfActualNotProvided is false",
  );
}

function evaluateStringField(
  expr: string | ((...args: unknown[]) => string | undefined) | undefined,
  args: unknown[],
): string | undefined {
  if (typeof expr === "function") {
    return expr(...args);
  }
  return expr;
}

/** Build wire-format (snake_case) reservation create request body. */
function buildReservationBody(
  cfg: WithCyclesConfig,
  estimate: number,
  defaultSubject: SubjectDefaults,
  args: unknown[],
): Record<string, unknown> {
  validateNonNegative(estimate, "estimate");
  const ttlMs = cfg.ttlMs ?? DEFAULT_TTL_MS;
  validateTtlMs(ttlMs);

  const subject: Record<string, unknown> = {};
  for (const field of [
    "tenant",
    "workspace",
    "app",
    "workflow",
    "agent",
    "toolset",
  ] as const) {
    const resolved = evaluateStringField(cfg[field], args);
    const val = resolved ?? defaultSubject[field];
    if (val) {
      subject[field] = val;
    }
  }
  if (cfg.dimensions) {
    subject.dimensions = cfg.dimensions;
  }

  validateSubject(subject as Subject);

  const action: Record<string, unknown> = {
    kind: evaluateStringField(cfg.actionKind, args) ?? "unknown",
    name: evaluateStringField(cfg.actionName, args) ?? "unknown",
  };
  if (cfg.actionTags) {
    action.tags = cfg.actionTags;
  }

  const unit = cfg.unit ?? "USD_MICROCENTS";

  const body: Record<string, unknown> = {
    idempotency_key: randomUUID(),
    subject,
    action,
    estimate: { unit, amount: estimate },
    ttl_ms: ttlMs,
    overage_policy: cfg.overagePolicy ?? "ALLOW_IF_AVAILABLE",
  };

  validateGracePeriodMs(cfg.gracePeriodMs);
  if (cfg.gracePeriodMs !== undefined) {
    body.grace_period_ms = cfg.gracePeriodMs;
  }
  if (cfg.dryRun) {
    body.dry_run = true;
  }

  return body;
}

/** Build wire-format commit request body. */
function buildCommitBody(
  actual: number,
  unit: string,
  metrics: CyclesMetrics | undefined,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    idempotency_key: randomUUID(),
    actual: { unit, amount: actual },
  };

  if (metrics && !isMetricsEmpty(metrics)) {
    body.metrics = metricsToWire(metrics);
  }
  if (metadata) {
    body.metadata = metadata;
  }
  return body;
}

/**
 * Build a POST /v1/events body that records the spend of a commit whose
 * reservation expired before the commit landed (the server has already
 * returned the reserved budget to the pool at that point).
 *
 * Reuses the commit's idempotency key — the event idempotency namespace is
 * separate, so replays across process restarts stay exactly-once. Omits
 * overage_policy: the spec default ALLOW_IF_AVAILABLE never rejects, which
 * is the right bias when the spend has already happened.
 */
export function buildEventFallbackBody(
  reservationId: string,
  subject: Record<string, unknown>,
  action: Record<string, unknown>,
  commitBody: Record<string, unknown>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    ...((commitBody.metadata as Record<string, unknown> | undefined) ?? {}),
    recovered_reservation_id: reservationId,
    recovery_reason: "commit_after_reservation_expired",
  };
  const body: Record<string, unknown> = {
    idempotency_key: commitBody.idempotency_key,
    subject,
    action,
    actual: commitBody.actual,
    metadata,
  };
  if ("metrics" in commitBody) {
    body.metrics = commitBody.metrics;
  }
  return body;
}

/** Build wire-format release request body. */
function buildReleaseBody(reason: string): Record<string, unknown> {
  return { idempotency_key: randomUUID(), reason };
}

/**
 * Extend-error codes that no retry can ever fix: the reservation is gone
 * (expired), settled (finalized), or the server refuses further extensions.
 * The heartbeat stops permanently on any of these instead of hammering the
 * server with doomed retries forever.
 */
export const PERMANENT_EXTEND_ERROR_CODES: ReadonlySet<string> = new Set([
  "RESERVATION_EXPIRED",
  "RESERVATION_FINALIZED",
  "MAX_EXTENSIONS_EXCEEDED",
  "TENANT_CLOSED", // tenant closure is irreversible
  "NOT_FOUND", // a 404'd reservation never comes back
]);

/** Extract the wire error code from a non-2xx response (body-tolerant). */
export function extractExtendErrorCode(response: {
  getErrorResponse: () => { error?: string } | undefined;
  getBodyAttribute: (key: string) => unknown;
}): string | undefined {
  const structured = response.getErrorResponse()?.error;
  if (structured !== undefined) return structured;
  const raw = response.getBodyAttribute("error");
  return typeof raw === "string" ? raw : undefined;
}

export class AsyncCyclesLifecycle {
  private readonly _client: CyclesClient;
  private readonly _retryEngine: CommitRetryEngine;
  private readonly _defaultSubject: SubjectDefaults;

  constructor(
    client: CyclesClient,
    retryEngine: CommitRetryEngine,
    defaultSubject: SubjectDefaults,
  ) {
    this._client = client;
    this._retryEngine = retryEngine;
    this._retryEngine.setClient(client);
    this._defaultSubject = defaultSubject;
  }

  async execute<T>(
    fn: (...args: unknown[]) => Promise<T>,
    args: unknown[],
    cfg: WithCyclesConfig,
  ): Promise<T> {
    const estimate = evaluateAmount(cfg.estimate, args);

    const createBody = buildReservationBody(
      cfg,
      estimate,
      this._defaultSubject,
      args,
    );
    const resResponse = await this._client.createReservation(createBody);

    if (!resResponse.isSuccess) {
      throw buildProtocolException("Failed to create reservation", resResponse);
    }

    // Parse wire-format response into typed object
    const resResult = reservationCreateResponseFromWire(
      resResponse.body as Record<string, unknown>,
    );
    const resT2 = performance.now();

    const decision = resResult.decision as Decision;
    const reservationId = resResult.reservationId;
    const reasonCode = resResult.reasonCode;

    // Handle dry-run
    if (cfg.dryRun) {
      if (decision === "DENY") {
        throw buildProtocolException("Dry-run denied", resResponse);
      }
      return {
        decision,
        caps: resResult.caps,
        affectedScopes: resResult.affectedScopes,
        scopePath: resResult.scopePath,
        reserved: resResult.reserved,
        balances: resResult.balances,
        reasonCode,
        retryAfterMs: resResult.retryAfterMs,
      } as unknown as T;
    }

    // Handle DENY
    if (decision === "DENY") {
      throw buildProtocolException("Reservation denied", resResponse);
    }

    if (!reservationId) {
      throw new CyclesProtocolError(
        "Reservation successful but reservation_id missing",
        { status: resResponse.status },
      );
    }

    const unit = cfg.unit ?? "USD_MICROCENTS";
    const ttlMs = cfg.ttlMs ?? DEFAULT_TTL_MS;

    // Set context
    const ctx: CyclesContext = {
      reservationId,
      estimate,
      decision,
      caps: resResult.caps,
      expiresAtMs: resResult.expiresAtMs,
      affectedScopes: resResult.affectedScopes,
      scopePath: resResult.scopePath,
      reserved: resResult.reserved,
      balances: resResult.balances,
    };

    // Start heartbeat. The requested ttl is what every extend asks for.
    // When the create response carries the server-authoritative
    // remaining_ttl_ms (spec PR #148), the first beat is scheduled from
    // it exactly; otherwise the first beat fires immediately (see
    // _startHeartbeat).
    const heartbeatRef = this._startHeartbeat(
      reservationId,
      ttlMs,
      resResult.remainingTtlMs,
      ctx,
    );

    try {
      const result = await runWithContext(ctx, () => fn(...args));
      const methodElapsed = Math.round(performance.now() - resT2);

      // Resolve actual
      const useEstimateFallback = cfg.useEstimateIfActualNotProvided !== false;
      const { amount: actualAmount, usedEstimateFallback } = evaluateActual(
        cfg.actual,
        result,
        estimate,
        useEstimateFallback,
      );

      // Build commit
      let metrics = ctx.metrics;
      if (!metrics) {
        metrics = {};
      }
      if (metrics.latencyMs === undefined) {
        metrics = { ...metrics, latencyMs: methodElapsed };
      }

      // Audit honesty: when no `actual` was configured and the estimate is
      // committed in its place, mark the commit so downstream consumers can
      // tell measured spend from estimated spend. The marker also flows
      // into the /v1/events fallback body, which copies commit metadata.
      let commitMetadata = ctx.commitMetadata;
      if (usedEstimateFallback) {
        commitMetadata = { ...(commitMetadata ?? {}), actual_source: "estimate" };
        console.debug(
          `[runcycles] No actual configured; committing estimate as actual (metadata.actual_source="estimate"): ${reservationId}`,
        );
      }

      const commitBody = buildCommitBody(
        actualAmount,
        unit,
        metrics,
        commitMetadata,
      );
      const eventFallback = buildEventFallbackBody(
        reservationId,
        createBody.subject as Record<string, unknown>,
        createBody.action as Record<string, unknown>,
        commitBody,
      );
      await this._handleCommit(reservationId, commitBody, eventFallback);

      return result;
    } catch (err) {
      await this._handleRelease(reservationId, "guarded_method_failed");
      throw err;
    } finally {
      if (heartbeatRef) {
        heartbeatRef.stop();
      }
    }
  }

  private async _handleCommit(
    reservationId: string,
    commitBody: Record<string, unknown>,
    eventFallbackBody: Record<string, unknown>,
  ): Promise<void> {
    try {
      const response = await this._client.commitReservation(
        reservationId,
        commitBody,
      );
      if (response.isSuccess) {
        return;
      }

      if (response.isTransportError || response.isServerError) {
        this._retryEngine.schedule(reservationId, commitBody, eventFallbackBody);
        return;
      }

      const errorResp = response.getErrorResponse();
      let errorCode = errorResp?.error;

      // Fallback: extract error code directly from body when the structured
      // error response is unavailable (e.g. body missing request_id).
      if (errorCode === undefined) {
        const rawError = response.getBodyAttribute("error");
        if (typeof rawError === "string") {
          errorCode = rawError;
        }
      }

      if (response.status === 429 || errorCode === "LIMIT_EXCEEDED") {
        // Rate-limited, not rejected: releasing here would return budget
        // for spend that already happened. Retry instead, honoring the
        // server's Retry-After.
        this._retryEngine.schedule(
          reservationId,
          commitBody,
          eventFallbackBody,
          response.retryAfterMsHeader,
        );
        return;
      }
      if (response.status === 401 || response.status === 403) {
        // Credentials failed after the spend happened: journal the commit
        // for replay once they're fixed. Never release — that would return
        // budget for real spend.
        console.error(
          `[runcycles] Commit got authentication failure (status=${response.status}); journaling for replay: ${reservationId}`,
        );
        this._retryEngine.schedule(reservationId, commitBody, eventFallbackBody);
        return;
      }
      if (response.status === 410 || errorCode === "RESERVATION_EXPIRED") {
        // The server has already returned the reserved budget to the pool;
        // recover the spend via the post-hoc direct-debit endpoint. The
        // status check catches bodyless 410 Gone responses.
        console.warn(
          `[runcycles] Reservation expired before commit; recovering spend via POST /v1/events: ${reservationId}`,
        );
        this._retryEngine.scheduleEvent(reservationId, eventFallbackBody);
        return;
      }
      if (errorCode === "RESERVATION_FINALIZED") {
        return;
      }
      if (errorCode === "IDEMPOTENCY_MISMATCH") {
        return;
      }
      if (response.isClientError) {
        if (
          errorCode !== undefined &&
          errorCodeFromString(errorCode) !== ErrorCode.UNKNOWN
        ) {
          // Recognized protocol code — a genuine rejection the retry
          // engine cannot fix. Releasing returns the reserved budget.
          await this._handleRelease(
            reservationId,
            `commit_rejected_${errorCode}`,
          );
          return;
        }
        // Codeless, mangled, or forward-compat unknown 4xx: unclassifiable.
        // Never release or discard real spend on a response we cannot
        // interpret — journal it for background retry / next-run replay.
        console.error(
          `[runcycles] Commit got unclassifiable client error (status=${response.status}, error=${String(errorCode)}); journaling for replay: ${reservationId}`,
        );
        this._retryEngine.schedule(reservationId, commitBody, eventFallbackBody);
        return;
      }
    } catch {
      this._retryEngine.schedule(reservationId, commitBody, eventFallbackBody);
    }
  }

  private async _handleRelease(
    reservationId: string,
    reason: string,
  ): Promise<void> {
    try {
      const body = buildReleaseBody(reason);
      await this._client.releaseReservation(reservationId, body);
    } catch {
      // Best-effort release
    }
  }

  /**
   * `ttlMs` is the REQUESTED ttl: it is what every `extend_by_ms` asks for
   * and it bounds the fallback beat cadence. `createRemainingTtlMs` is the
   * server-authoritative `remaining_ttl_ms` from the create response
   * (spec PR #148), when present.
   */
  private _startHeartbeat(
    reservationId: string,
    ttlMs: number,
    createRemainingTtlMs: number | undefined,
    ctx: CyclesContext,
  ): { stop: () => void } | undefined {
    if (ttlMs <= 0) return undefined;
    validateExtendByMs(ttlMs);
    // FALLBACK cadence (servers without remaining_ttl_ms): the FIRST beat
    // fires IMMEDIATELY (delay 0). Tenant policy max_reservation_ttl_ms
    // may have silently capped the granted TTL far below the requested
    // one (governance default: 1 hour), the create response then has no
    // effective-TTL signal, and spec review round 4 confirmed that ANY
    // bounded first-beat delay can outlive a small capped lease — so the
    // first extend primes the lease with a real, measurable grant right
    // away instead of gambling on an unknowable one. After each applied
    // grant the cadence re-derives from the MEASURED grant:
    // clamp(grant/2, 500, ttl/2), except under a suspected lead clamp
    // (see the regime split in the success handler), where it holds at
    // min(ttl/2, 30 s). The 500 ms floor cannot starve liveness — it
    // binds only when the server grants less than 1 s per extend, i.e.
    // below the spec's own minimum ttl_ms.
    const heldIntervalMs = Math.min(ttlMs / 2, 30_000);
    let intervalMs = heldIntervalMs;
    let stopped = false;
    let currentTimer: ReturnType<typeof setTimeout> | undefined;

    // --- Server-authoritative scheduling (remaining_ttl_ms, round 5) ---
    // remaining_ttl_ms (spec PR #148, on create and extend responses) is
    // the remaining lifetime at response evaluation, in the same clock
    // snapshot as expires_at_ms. When present it is NORMATIVE: the
    // (grant, elapsed) regime heuristic below is formally undecidable —
    // e.g. ttl 24 s with +10 s grants gives a held cadence of 12 s and a
    // post-skip grant/elapsed ratio of 10/12 ~ 0.83 that sits inside the
    // clamp band forever while the lease erodes to a lapse — so exact
    // scheduling always wins when the server provides it. fieldMode
    // tracks whether the LATEST successful response carried the field;
    // the heuristic bookkeeping keeps running underneath so it can take
    // over seamlessly if the field disappears mid-flight (proxy strips
    // it, mixed-version server fleet, ...).
    let fieldMode = false;
    let maxObservedRttMs = 0;
    let lastLeadFloorMs = 0;
    let lastLeadFloorMono = 0;

    // leadFloor = max(0, remaining_ttl_ms - rtt) is a lower bound on the
    // lease remaining NOW: the response was evaluated at most one
    // round-trip ago. The next beat lands retryReserve before the floor
    // runs out — at least 1 s (or 2x the worst observed rtt) of margin
    // for the extend call itself, but never more than half the floor so
    // short leases still get a usable wait. Returns the next-beat delay,
    // measured from response receipt.
    const scheduleFromField = (
      remainingMs: number,
      rttMs: number,
      nowMono: number,
    ): number => {
      fieldMode = true;
      maxObservedRttMs = Math.max(maxObservedRttMs, rttMs);
      const leadFloor = Math.max(remainingMs - rttMs, 0);
      lastLeadFloorMs = leadFloor;
      lastLeadFloorMono = nowMono;
      const retryReserve = Math.min(
        leadFloor / 2,
        Math.max(1000, 2 * maxObservedRttMs),
      );
      return Math.max(leadFloor - retryReserve, 0);
    };

    // Field-mode transient-failure retry delay: clamp(lead/4, 1 s, 30 s),
    // where lead is the last leadFloor decayed by monotonic elapsed time.
    const fieldRetryDelayMs = (): number => {
      const leadEstimate = Math.max(
        lastLeadFloorMs - (performance.now() - lastLeadFloorMono),
        0,
      );
      return Math.min(Math.max(leadEstimate / 4, 1000), 30_000);
    };

    // Lead lower-bound extension. `extend_by_ms` extends relative to the
    // CURRENT expires_at_ms (spec), so blindly extending by ttlMs on
    // every beat would drift expiry outward per beat (zombie budget
    // lockup on process death) and burn the server's max_extensions
    // budget faster than needed. Each beat instead computes a rigorous
    // LOWER BOUND on the expiry lead:
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
    let prevExpiry = ctx.expiresAtMs;
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
      if (stopped) return;
      currentTimer = setTimeout(() => {
        if (stopped) return;
        // Heuristic skip check — BYPASSED in field mode: there the
        // schedule is exact, and a heuristic skip could push the beat
        // past the real lease.
        if (!fieldMode) {
          const leadMin = grantsSum - (performance.now() - anchor);
          if (lastGrant !== undefined && leadMin >= 1.5 * lastGrant) {
            // Plenty of proven lead — skip this beat (no server call).
            tick(intervalMs);
            return;
          }
        }
        const key = pendingKey ?? randomUUID();
        pendingKey = key;
        const body = { idempotency_key: key, extend_by_ms: ttlMs };
        const sentMono = performance.now();
        // Delay until the next beat, finalized by the handlers below and
        // consumed once in .finally.
        let nextDelayMs = intervalMs;
        void this._client
          .extendReservation(reservationId, body)
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
              const rttMs = Math.max(now - sentMono, 0);
              const elapsedSinceSuccess = now - (lastSuccessMono ?? anchor);
              lastSuccessMono = now;
              const remaining = response.getBodyAttribute("remaining_ttl_ms");
              if (typeof remaining === "number") {
                // NORMATIVE path: schedule exactly from the server's own
                // remaining lifetime; never accumulate expiry
                // differences here. The heuristic bookkeeping below
                // still runs so it can take over if the field vanishes.
                nextDelayMs = scheduleFromField(remaining, rttMs, now);
                grantsSum += Math.max(grant, 0);
                lastGrant = Math.max(grant, 0);
                if (prevExpiry !== undefined) {
                  ctx.expiresAtMs = prevExpiry;
                }
                return;
              }
              fieldMode = false;
              // Regime split (spec review round 4). Under a maximum-LEAD
              // clamp the server holds expires_at_ms ~ now + L, so the
              // difference of successive expires_at_ms values measures
              // ELAPSED TIME, not granted lease — deriving the cadence
              // from it would collapse the interval to the floor and burn
              // max_extensions in seconds. A grant is treated as
              // lead-clamped when it is non-positive (no lease movement)
              // or both well below the requested ttl AND explainable as
              // elapsed time: within the 0.75x-1.25x BAND of the time
              // since the last applied extend. The band must be two-sided
              // (Rust-port finding, adopted fleet-wide): after a leadMin
              // skip the next grant arrives across a doubled gap, so a
              // genuine grant-clamped server (grant/2 cadence) also shows
              // grant ~ elapsed exactly once — an upper bound alone would
              // classify it as lead-clamped and the hold would
              // self-sustain (at the held cadence grant stays <= elapsed
              // forever, decaying the lease to a lapse). With the band, a
              // real maximum-lead clamp tracks ANY gap with ratio ~ 1 and
              // stays held, while the post-skip real grant lands in the
              // hold once: at the held cadence its ratio falls to ~ 0.5,
              // exits the band, and the cadence re-tightens. Only a REAL
              // per-extend grant may tighten the cadence.
              if (
                grant <= 0 ||
                (grant < 0.9 * ttlMs &&
                  grant >= 0.75 * elapsedSinceSuccess &&
                  grant <= 1.25 * elapsedSinceSuccess)
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
              if (prevExpiry !== undefined) {
                ctx.expiresAtMs = prevExpiry;
              }
              nextDelayMs = intervalMs;
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
              stopped = true;
              return;
            }
            if (fieldMode) {
              nextDelayMs = fieldRetryDelayMs();
            }
            console.warn(
              `[runcycles] Heartbeat extend failed (status=${response.status}); retrying next beat: ${reservationId}`,
            );
          })
          .catch(() => {
            // Transport error: best-effort — retry next beat, same key.
            if (fieldMode) {
              nextDelayMs = fieldRetryDelayMs();
            }
          })
          .finally(() => {
            tick(nextDelayMs);
          });
      }, delayMs);
    };

    if (typeof createRemainingTtlMs === "number") {
      // Server-authoritative first delay, derived from the create
      // response's remaining_ttl_ms with the same formula as every later
      // beat (create rtt is unknown -> 0). No immediate prime: under a
      // maximum-lead clamp an immediate extend would only waste one of
      // max_extensions, and the exact schedule already lands the first
      // beat inside the real lease.
      tick(scheduleFromField(createRemainingTtlMs, 0, anchor));
    } else {
      // FALLBACK: immediate first beat — see the comment above
      // heldIntervalMs. The 0 delay applies to this first schedule ONLY:
      // every reschedule passes a delay that never becomes 0 (heuristic
      // reschedules use intervalMs, which starts at heldIntervalMs; a
      // transient failure in field mode waits at least 1 s) — so a
      // transient failure on the immediate first attempt never hot-loops
      // against a down server.
      tick(0);
    }
    return {
      stop: () => {
        stopped = true;
        clearTimeout(currentTimer);
      },
    };
  }
}
