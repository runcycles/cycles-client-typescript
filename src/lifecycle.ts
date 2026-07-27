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

/**
 * Compute the EFFECTIVE granted TTL for heartbeat scheduling.
 *
 * Tenant policy `max_reservation_ttl_ms` silently CAPS the granted TTL at
 * reserve time (governance default: 1 hour) and the create response has no
 * effective-TTL field — seeding the heartbeat from the REQUESTED ttl would
 * schedule the first beat far too late (a 24h request capped to 1h would
 * put the first beat at 12h, long after expiry). Recover the granted TTL
 * as `expires_at_ms - HTTP Date header`: both terms are server-frame, so
 * the difference is clock-skew-free (HTTP-date resolution is ~1s, which
 * the heartbeat margins absorb). Clamped to [1000, requestedTtlMs]; falls
 * back to the requested ttl when either server timestamp is unavailable.
 */
export function computeEffectiveTtlMs(
  requestedTtlMs: number,
  expiresAtMs: number | undefined,
  serverDateMs: number | undefined,
): number {
  if (expiresAtMs === undefined || serverDateMs === undefined) {
    return requestedTtlMs;
  }
  const grantedMs = expiresAtMs - serverDateMs;
  return Math.min(Math.max(grantedMs, 1_000), requestedTtlMs);
}

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

    // Start heartbeat, seeded from the EFFECTIVE granted TTL — a tenant
    // policy may have silently capped the requested one at reserve time.
    const effectiveTtlMs = computeEffectiveTtlMs(
      ttlMs,
      resResult.expiresAtMs,
      resResponse.serverDateMs,
    );
    const heartbeatRef = this._startHeartbeat(reservationId, effectiveTtlMs, ctx);

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
   * `ttlMs` is the EFFECTIVE granted TTL (see {@link computeEffectiveTtlMs}),
   * used for the beat interval, the lead estimate, the skip threshold, and
   * the requested `extend_by_ms` alike.
   */
  private _startHeartbeat(
    reservationId: string,
    ttlMs: number,
    ctx: CyclesContext,
  ): { stop: () => void } | undefined {
    if (ttlMs <= 0) return undefined;
    validateExtendByMs(ttlMs);
    // Beat every ttl/2 — deliberately NO lower floor. The spec's minimum
    // ttl_ms is 1000, so the interval is at least 500ms; a floor could only
    // ever bind for ttl < 2000, where beating slower than ttl/2 guarantees
    // the reservation lapses between beats.
    const intervalMs = ttlMs / 2;
    let stopped = false;
    let currentTimer: ReturnType<typeof setTimeout> | undefined;

    // Lead-estimate extension. `extend_by_ms` extends relative to the
    // CURRENT expires_at_ms (spec), so blindly extending by ttlMs on every
    // ttl/2 beat would drift expiry outward by ttl/2 per beat (zombie
    // budget lockup on process death) and burn the server's max_extensions
    // budget twice as fast as needed. Instead each beat estimates the
    // expiry LEAD — how far ahead of "now" the expiry sits — and skips the
    // extend only when the lead is already comfortably large (>= 1.5*ttl).
    //
    // The estimate is clock-skew-free by construction: it only ever
    // subtracts server timestamps from server timestamps and client
    // monotonic timestamps from client monotonic timestamps — the client
    // wall clock is never compared to the server's expires_at_ms:
    //
    //   lead = (knownExpiry - initialExpiry) + ttlMs - (now - anchor)
    //
    // where `initialExpiry`/`knownExpiry` are server-frame expiries and
    // `anchor` is a client performance.now() reading taken at heartbeat
    // start. `grantedMs` tracks the server-frame difference
    // (knownExpiry - initialExpiry); when no server-frame reference is
    // available (create or extend response without a numeric
    // expires_at_ms) it accumulates ttlMs per applied grant instead. The
    // estimate is optimistic by at most one response leg (expiries are
    // read after the network round trip), which the ttl/2 cadence and the
    // 1.5*ttl skip threshold absorb.
    const initialExpiry = ctx.expiresAtMs;
    let knownExpiry = initialExpiry;
    const anchor = performance.now();
    let grantedMs = 0;
    // Idempotency key of an extend whose outcome we never saw. It is
    // reused on the retry so a lost response cannot double-extend.
    let pendingKey: string | undefined;

    const tick = (): void => {
      if (stopped) return;
      currentTimer = setTimeout(() => {
        if (stopped) return;
        const elapsed = performance.now() - anchor;
        const leadMs = grantedMs + ttlMs - elapsed;
        if (leadMs >= 1.5 * ttlMs) {
          // Plenty of lead — skip this beat (no server call).
          tick();
          return;
        }
        const key = pendingKey ?? randomUUID();
        pendingKey = key;
        const body = { idempotency_key: key, extend_by_ms: ttlMs };
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
              if (
                typeof newExpires === "number" &&
                initialExpiry !== undefined
              ) {
                // Authoritative server-frame resync (self-corrects after
                // clamped grants or missing bodies).
                grantedMs = newExpires - initialExpiry;
                knownExpiry = newExpires;
                ctx.expiresAtMs = newExpires;
              } else {
                // No server-frame diff available — count the applied grant
                // optimistically as +ttlMs of lead.
                grantedMs += ttlMs;
                if (typeof newExpires === "number") {
                  knownExpiry = newExpires;
                  ctx.expiresAtMs = newExpires;
                } else if (knownExpiry !== undefined) {
                  knownExpiry += ttlMs;
                  ctx.expiresAtMs = knownExpiry;
                }
              }
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
            console.warn(
              `[runcycles] Heartbeat extend failed (status=${response.status}); retrying next beat: ${reservationId}`,
            );
          })
          .catch(() => {
            // Transport error: best-effort — retry next beat, same key.
          })
          .finally(() => {
            tick();
          });
      }, intervalMs);
    };

    tick();
    return {
      stop: () => {
        stopped = true;
        clearTimeout(currentTimer);
      },
    };
  }
}
