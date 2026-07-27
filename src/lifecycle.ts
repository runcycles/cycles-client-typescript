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
): number {
  if (expr !== undefined) {
    if (typeof expr === "function") {
      return expr(result);
    }
    return expr;
  }
  if (useEstimateFallback) {
    return estimate;
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

/** Build wire-format extend request body. */
function buildExtendBody(extendByMs: number): Record<string, unknown> {
  validateExtendByMs(extendByMs);
  return { idempotency_key: randomUUID(), extend_by_ms: extendByMs };
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

    // Start heartbeat
    const heartbeatRef = this._startHeartbeat(reservationId, ttlMs, ctx);

    try {
      const result = await runWithContext(ctx, () => fn(...args));
      const methodElapsed = Math.round(performance.now() - resT2);

      // Resolve actual
      const useEstimateFallback = cfg.useEstimateIfActualNotProvided !== false;
      const actualAmount = evaluateActual(
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

      const commitBody = buildCommitBody(
        actualAmount,
        unit,
        metrics,
        ctx.commitMetadata,
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

  private _startHeartbeat(
    reservationId: string,
    ttlMs: number,
    ctx: CyclesContext,
  ): { stop: () => void } | undefined {
    if (ttlMs <= 0) return undefined;
    const intervalMs = Math.max(ttlMs / 2, 1_000);
    let stopped = false;
    let currentTimer: ReturnType<typeof setTimeout> | undefined;

    const tick = (): void => {
      if (stopped) return;
      currentTimer = setTimeout(() => {
        if (stopped) return;
        const body = buildExtendBody(ttlMs);
        void this._client
          .extendReservation(reservationId, body)
          .then((response) => {
            if (response.isSuccess) {
              // Wire-format key
              const newExpires = response.getBodyAttribute("expires_at_ms");
              if (typeof newExpires === "number") {
                ctx.expiresAtMs = newExpires;
              }
            }
          })
          .catch(() => {
            // Best-effort heartbeat
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
