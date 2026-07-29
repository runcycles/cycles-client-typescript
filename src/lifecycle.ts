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
  isRetryableErrorCode,
  type CyclesMetrics,
  type Decision,
  type Subject,
} from "./models.js";
import type { CyclesResponse } from "./response.js";
import type { CommitRetryEngine } from "./retry.js";
import { isSchemaValidCommitSuccess } from "./settlement.js";
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

/**
 * Success predicate for the PRIMARY (remaining_ttl_ms) heartbeat path,
 * per the spec's HEARTBEAT GUIDANCE: only a schema-valid HTTP 200
 * ReservationExtendResponse counts as an observed success — required
 * `status: "ACTIVE"` and integer `expires_at_ms >= 0`, plus an integer
 * `remaining_ttl_ms >= 0` when present. Any other or malformed 2xx is
 * AMBIGUOUS: it must not be used to schedule from stale state and is
 * handled like a transient failure with same-key recovery. This exact
 * observed-success rule applies in both authoritative and fallback modes.
 */
const UNITS = new Set([
  "USD_MICROCENTS",
  "TOKENS",
  "CREDITS",
  "RISK_POINTS",
]);
const DECISIONS = new Set(["ALLOW", "ALLOW_WITH_CAPS", "DENY"]);
const CREATE_RESPONSE_FIELDS = new Set([
  "decision",
  "reservation_id",
  "affected_scopes",
  "expires_at_ms",
  "remaining_ttl_ms",
  "scope_path",
  "reserved",
  "caps",
  "reason_code",
  "retry_after_ms",
  "balances",
  "cycles_evidence",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isInteger(value: unknown, minimum?: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Number.isFinite(value) &&
    (minimum === undefined || value >= minimum)
  );
}

/** Conservative create-response lead at the instant heartbeat scheduling starts. */
export function createLeadFloorAtScheduleStart(
  remainingTtlMs: number,
  createRttMs: number,
  createReceivedMono: number,
  scheduleStartedMono: number,
): number | undefined {
  const elapsedAfterReceipt = scheduleStartedMono - createReceivedMono;
  if (
    !Number.isFinite(createRttMs) ||
    createRttMs < 0 ||
    !Number.isFinite(createReceivedMono) ||
    !Number.isFinite(scheduleStartedMono) ||
    !Number.isFinite(elapsedAfterReceipt) ||
    elapsedAfterReceipt < 0
  ) {
    return undefined;
  }
  return Math.max(
    0,
    Math.floor(remainingTtlMs - createRttMs - elapsedAfterReceipt),
  );
}

function isStringArray(value: unknown, maxLength?: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "string" &&
        (maxLength === undefined || Array.from(item).length <= maxLength),
    )
  );
}

function isAmount(value: unknown, signed: boolean): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, new Set(["unit", "amount"]))) return false;
  return (
    typeof value.unit === "string" &&
    UNITS.has(value.unit) &&
    isInteger(value.amount, signed ? undefined : 0)
  );
}

function isCaps(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(
      value,
      new Set([
        "max_tokens",
        "max_steps_remaining",
        "tool_allowlist",
        "tool_denylist",
        "cooldown_ms",
      ]),
    )
  ) {
    return false;
  }
  for (const key of [
    "max_tokens",
    "max_steps_remaining",
    "cooldown_ms",
  ] as const) {
    if (value[key] !== undefined && !isInteger(value[key], 0)) return false;
  }
  for (const key of ["tool_allowlist", "tool_denylist"] as const) {
    if (value[key] !== undefined && !isStringArray(value[key], 256)) {
      return false;
    }
  }
  return true;
}

function isBalance(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(
      value,
      new Set([
        "scope",
        "scope_path",
        "remaining",
        "reserved",
        "spent",
        "allocated",
        "debt",
        "overdraft_limit",
        "is_over_limit",
      ]),
    )
  ) {
    return false;
  }
  if (
    typeof value.scope !== "string" ||
    typeof value.scope_path !== "string" ||
    !isAmount(value.remaining, true)
  ) {
    return false;
  }
  for (const key of [
    "reserved",
    "spent",
    "allocated",
    "debt",
    "overdraft_limit",
  ] as const) {
    if (value[key] !== undefined && !isAmount(value[key], false)) return false;
  }
  return (
    value.is_over_limit === undefined ||
    typeof value.is_over_limit === "boolean"
  );
}

function isBalances(value: unknown): boolean {
  return Array.isArray(value) && value.every((balance) => isBalance(balance));
}

function isEvidenceRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, new Set(["evidence_id", "cycles_evidence_url"])) ||
    typeof value.evidence_id !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.evidence_id) ||
    typeof value.cycles_evidence_url !== "string"
  ) {
    return false;
  }
  try {
    new URL(value.cycles_evidence_url);
    return true;
  } catch {
    return false;
  }
}

/** Exact HTTP-200 plus full ReservationCreateResponse schema validation. */
export function isSchemaValidCreateResponse(response: {
  status: number;
  body: Record<string, unknown> | undefined;
}): boolean {
  if (response.status !== 200 || !isRecord(response.body)) return false;
  const body = response.body;
  if (!hasOnlyKeys(body, CREATE_RESPONSE_FIELDS)) return false;
  if (!DECISIONS.has(body.decision as string)) return false;
  if (!isStringArray(body.affected_scopes)) return false;
  if (
    body.reservation_id !== undefined &&
    typeof body.reservation_id !== "string"
  ) {
    return false;
  }
  if (
    body.expires_at_ms !== undefined &&
    !isInteger(body.expires_at_ms, 0)
  ) {
    return false;
  }
  if (
    body.remaining_ttl_ms !== undefined &&
    !isInteger(body.remaining_ttl_ms, 0)
  ) {
    return false;
  }
  if (body.scope_path !== undefined && typeof body.scope_path !== "string") {
    return false;
  }
  if (body.reserved !== undefined && !isAmount(body.reserved, false)) {
    return false;
  }
  if (body.caps !== undefined && !isCaps(body.caps)) return false;
  if (
    body.reason_code !== undefined &&
    (typeof body.reason_code !== "string" ||
      Array.from(body.reason_code).length > 128)
  ) {
    return false;
  }
  if (
    body.retry_after_ms !== undefined &&
    !isInteger(body.retry_after_ms, 0)
  ) {
    return false;
  }
  if (body.balances !== undefined && !isBalances(body.balances)) return false;
  return (
    body.cycles_evidence === undefined ||
    isEvidenceRef(body.cycles_evidence)
  );
}

/** Exact HTTP-200 plus full ReservationExtendResponse schema validation. */
export function isSchemaValidExtendResponse(response: {
  status: number;
  body: Record<string, unknown> | undefined;
}): boolean {
  if (response.status !== 200 || !isRecord(response.body)) return false;
  const body = response.body;
  if (
    !hasOnlyKeys(
      body,
      new Set(["status", "expires_at_ms", "remaining_ttl_ms", "balances"]),
    )
  ) {
    return false;
  }
  if (body.status !== "ACTIVE" || !isInteger(body.expires_at_ms, 0)) {
    return false;
  }
  if (
    body.remaining_ttl_ms !== undefined &&
    !isInteger(body.remaining_ttl_ms, 0)
  ) {
    return false;
  }
  return body.balances === undefined || isBalances(body.balances);
}

function isRecoverableCreateAmbiguity(response: CyclesResponse): boolean {
  return (
    response.isTransportError ||
    response.isServerError ||
    response.isSuccess
  );
}

/**
 * Create a reservation, allowing one immediate same-key recovery for a
 * transport/5xx/ambiguous-2xx outcome.
 */
export async function createReservationWithRecovery(
  client: CyclesClient,
  body: Record<string, unknown>,
): Promise<{
  response: CyclesResponse;
  result: ReturnType<typeof reservationCreateResponseFromWire>;
  rttMs: number;
  receivedMono: number;
}> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sentMono = performance.now();
    let response: CyclesResponse;
    try {
      response = await client.createReservation(body);
    } catch (error) {
      if (attempt === 0) continue;
      throw new CyclesProtocolError(
        `Create reservation remained ambiguous after same-key retry: ${String(error)}`,
      );
    }
    if (isSchemaValidCreateResponse(response)) {
      const receivedMono = performance.now();
      return {
        response,
        result: reservationCreateResponseFromWire(response.body!),
        rttMs: receivedMono - sentMono,
        receivedMono,
      };
    }
    if (attempt === 0 && isRecoverableCreateAmbiguity(response)) continue;
    if (!response.isSuccess) {
      throw buildProtocolException("Failed to create reservation", response);
    }
    throw new CyclesProtocolError(
      "Create reservation did not produce a schema-valid HTTP 200 response",
      { status: response.status },
    );
  }
  throw new CyclesProtocolError("Create reservation recovery exhausted");
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
    const {
      response: resResponse,
      result: resResult,
      rttMs: createRttMs,
      receivedMono: createReceivedMono,
    } = await createReservationWithRecovery(this._client, createBody);
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
      createRttMs,
      createReceivedMono,
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
    this._retryEngine.persistPending(
      reservationId,
      commitBody,
      eventFallbackBody,
    );
    try {
      const response = await this._client.commitReservation(
        reservationId,
        commitBody,
      );
      if (isSchemaValidCommitSuccess(response)) {
        this._retryEngine.discardPending(reservationId);
        return;
      }
      if (response.isSuccess) {
        console.warn(
          `[runcycles] Commit returned an ambiguous protocol-invalid 2xx (status=${response.status}); scheduling same-key retry: ${reservationId}`,
        );
        this._retryEngine.schedule(reservationId, commitBody, eventFallbackBody);
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
        this._retryEngine.discardPending(reservationId);
        return;
      }
      if (errorCode === "IDEMPOTENCY_MISMATCH") {
        this._retryEngine.discardPending(reservationId);
        return;
      }
      if (response.isClientError) {
        const parsedErrorCode = errorCodeFromString(errorCode);
        if (
          parsedErrorCode !== undefined &&
          parsedErrorCode !== ErrorCode.UNKNOWN &&
          !isRetryableErrorCode(parsedErrorCode)
        ) {
          // Recognized protocol code — a genuine rejection the retry
          // engine cannot fix. Releasing returns the reserved budget.
          this._retryEngine.discardPending(reservationId);
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
      this._retryEngine.schedule(reservationId, commitBody, eventFallbackBody);
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
   * (spec PR #148), when present; `createRttMs` / `createReceivedMono`
   * are the create call's own monotonic attempt timing.
   */
  private _startHeartbeat(
    reservationId: string,
    ttlMs: number,
    createRemainingTtlMs: number | undefined,
    createRttMs: number,
    createReceivedMono: number,
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

    // --- PRIMARY: server-authoritative scheduling (remaining_ttl_ms) ---
    // Per the spec's HEARTBEAT GUIDANCE (PR #148), NORMATIVE whenever a
    // schema-valid response carries remaining_ttl_ms — the remaining
    // lifetime at response evaluation, same clock snapshot as
    // expires_at_ms. The (grant, elapsed) regime heuristic below is
    // formally undecidable (e.g. ttl 24 s with +10 s grants gives a held
    // cadence of 12 s and a post-skip grant/elapsed ratio of 10/12 ~ 0.83
    // that sits inside the clamp band forever while the lease erodes to a
    // lapse), so exact scheduling always wins when the server provides
    // it. fieldMode tracks whether the LATEST schema-valid success
    // carried the field; the heuristic bookkeeping keeps running
    // underneath so it can take over seamlessly if the field disappears
    // mid-flight (proxy strips it, mixed-version server fleet, ...).
    //
    // Scheduling formula, recomputed from EVERY schema-valid response
    // alone (never accumulating expiry differences):
    //   rtt            = monotonic(response_received - attempt_sent),
    //                    per individual HTTP attempt (max tracked);
    //   lead_floor     = max(0, remaining_ttl_ms - rtt);
    //   attempt_budget = max(request_timeout_budget, 1 s, 2 x maxRtt);
    //   safety_margin  = max(1 s, 2 x maxRtt);
    //   retry_reserve  = 2 x attempt_budget + safety_margin;
    //   next_delay     = max(0, lead_floor - retry_reserve)
    // scheduled from response receipt. Budgets/margins round UP, leads
    // and delays round DOWN, so rounding never consumes the margin; all
    // arithmetic is overflow-safe (JS doubles saturate to Infinity —
    // an unknown/unbounded timeout makes attempt_budget Infinity and
    // next_delay 0). retry_reserve covers one failed attempt, one
    // same-key retry, and scheduling margin.
    let fieldMode = false;
    let maxObservedRttMs = 0;
    if (Number.isFinite(createRttMs) && createRttMs >= 0) {
      maxObservedRttMs = createRttMs;
    }
    let lastLeadFloorMs = 0;
    let lastLeadFloorMono = 0;
    // Zero-delay guard: a schema-valid success with next_delay = 0
    // permits ONE immediate fresh attempt (new idempotency key); two in a
    // row mean the lease cannot hold the retry-safety reserve -> stop.
    let zeroDelayStreak = 0;
    // Recovery progress guard state (spec: stop when neither monotonic
    // elapsed nor retry_window moves between consecutive failures).
    let lastFailMono: number | undefined;
    let lastFailWindow: number | undefined;
    let zeroWindowRetried = false;

    // The client's ENFORCED finite per-attempt bound: CyclesClient caps
    // every request with AbortSignal.timeout(connectTimeout+readTimeout).
    // Unknown or unbounded -> Infinity (the spec forbids pretending an
    // unbounded attempt fits any lease).
    const cfgTimeoutSum =
      this._client.config.connectTimeout + this._client.config.readTimeout;
    const requestTimeoutBudgetMs =
      Number.isFinite(cfgTimeoutSum) && cfgTimeoutSum > 0
        ? cfgTimeoutSum
        : Infinity;

    const attemptBudgetMs = (): number =>
      Math.ceil(Math.max(requestTimeoutBudgetMs, 1000, 2 * maxObservedRttMs));
    const safetyMarginMs = (): number =>
      Math.ceil(Math.max(1000, 2 * maxObservedRttMs));
    const retryReserveMs = (): number =>
      2 * attemptBudgetMs() + safetyMarginMs();

    /** last lead_floor decayed by monotonic elapsed time (floored at 0). */
    const currentLeadEstimateMs = (nowMono: number): number => {
      const elapsed = nowMono - lastLeadFloorMono;
      if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
      const decayed = lastLeadFloorMs - elapsed;
      return Number.isFinite(decayed) ? Math.max(0, Math.floor(decayed)) : 0;
    };

    const stopAndSurface = (reason: string): void => {
      stopped = true;
      console.warn(
        `[runcycles] Heartbeat stopped: ${reason}: ${reservationId}`,
      );
    };

    /**
     * Field-mode recovery decision for a transient failure (timeout,
     * connection error, 5xx, 429, or ambiguous 2xx). Recomputes
     * current_lead_estimate and retry_window from the SAME last
     * schema-valid response on every failure; repeated recovery is
     * allowed while the freshly recomputed window stays >= 0, always with
     * the SAME idempotency key. Returns the retry delay in ms, or
     * undefined when the heartbeat must stop (already surfaced).
     */
    const fieldRecoveryDelayMs = (
      retryAfter429Ms: number | undefined,
      is429: boolean,
    ): number | undefined => {
      const now = performance.now();
      const lead = currentLeadEstimateMs(now);
      // retry_window is deliberately UNclamped: negative means no
      // complete retry plus margin provably fits.
      const window = lead - attemptBudgetMs() - safetyMarginMs();
      if (window === 0 && zeroWindowRetried) {
        stopAndSurface(
          "retry window is still zero after the one permitted immediate recovery retry",
        );
        return undefined;
      }
      // Progress guard: between consecutive failures either monotonic
      // time advanced or the window shrank; otherwise a coarse clock
      // could sustain a zero-time recovery loop.
      if (
        lastFailMono !== undefined &&
        lastFailWindow !== undefined &&
        !(now > lastFailMono) &&
        !(window < lastFailWindow)
      ) {
        stopAndSurface(
          "no forward progress between recovery attempts (zero-time loop guard)",
        );
        return undefined;
      }
      lastFailMono = now;
      lastFailWindow = window;
      if (window < 0) {
        stopAndSurface(
          `remaining lease (${lead}ms) cannot hold one complete retry plus margin (need ${attemptBudgetMs() + safetyMarginMs()}ms)`,
        );
        return undefined;
      }
      if (window === 0) zeroWindowRetried = true;
      if (is429) {
        // Retry-After delta-seconds only, already converted to ms by the
        // response accessor (overflow is rejected, never wrapped). Honor it
        // exactly, and only when it fits the window — never invent an
        // earlier retry that violates throttling.
        if (retryAfter429Ms === undefined || !(retryAfter429Ms <= window)) {
          stopAndSurface(
            `rate limited and Retry-After ${retryAfter429Ms === undefined ? "is missing/invalid" : `(${retryAfter429Ms}ms) exceeds the safe retry window (${window}ms)`}`,
          );
          return undefined;
        }
        return retryAfter429Ms;
      }
      // window == 0 -> immediate retry; a second failure without
      // intervening success trips the progress guard above.
      return Math.max(0, Math.floor(Math.min(30_000, lead / 4, window)));
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
              const schemaValid = isSchemaValidExtendResponse(response);
              if (!schemaValid) {
                // Any non-200 or schema-invalid 2xx is ambiguous, in both
                // modes. It is not proof of application, and the pending
                // idempotency key must not be rotated.
                console.warn(
                  `[runcycles] Heartbeat extend returned an ambiguous 2xx (status=${response.status}); treating as transient: ${reservationId}`,
                );
                if (fieldMode) {
                  nextDelayMs = fieldRecoveryDelayMs(undefined, false) ?? 0;
                }
                return;
              }
              // Observed success.
              pendingKey = undefined;
              lastFailMono = undefined;
              lastFailWindow = undefined;
              zeroWindowRetried = false;
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
              const rttMs = now - sentMono;
              if (Number.isFinite(rttMs) && rttMs >= 0) {
                maxObservedRttMs = Math.max(maxObservedRttMs, rttMs);
              }
              const elapsedSinceSuccess = now - (lastSuccessMono ?? anchor);
              lastSuccessMono = now;
              const remaining = response.getBodyAttribute("remaining_ttl_ms");
              if (schemaValid && typeof remaining === "number") {
                // PRIMARY path: schedule exactly from the server's own
                // remaining lifetime; never accumulate expiry
                // differences here. The heuristic bookkeeping below
                // still runs so it can take over if the field vanishes.
                fieldMode = true;
                let leadFloor: number;
                if (!Number.isFinite(rttMs) || rttMs < 0) {
                  // Timing unavailable/unreliable: unknown elapsed time
                  // must NOT be treated as zero — lead_floor and
                  // next_delay collapse to 0. The zero-delay guard below
                  // then permits at most one immediate fresh attempt
                  // before stopping; this is never a silent downgrade to
                  // the fieldless fallback.
                  leadFloor = 0;
                } else {
                  maxObservedRttMs = Math.max(maxObservedRttMs, rttMs);
                  leadFloor = Math.max(0, Math.floor(remaining - rttMs));
                }
                lastLeadFloorMs = leadFloor;
                lastLeadFloorMono = now;
                nextDelayMs = Math.max(
                  0,
                  Math.floor(leadFloor - retryReserveMs()),
                );
                if (nextDelayMs === 0) {
                  if (zeroDelayStreak >= 1) {
                    // Two consecutive zero-delay schedules: the lease is
                    // shorter than the retry-safety budget — stop rather
                    // than burn max_extensions in a tight loop.
                    stopAndSurface(
                      `lease is shorter than the retry-safety budget (lead_floor=${leadFloor}ms, retry_reserve=${retryReserveMs()}ms)`,
                    );
                    return;
                  }
                  // One immediate FRESH attempt (new idempotency key —
                  // pendingKey was cleared above) is permitted: an
                  // additive-delta server's immediate extension can
                  // still establish positive lead.
                  zeroDelayStreak = 1;
                } else {
                  zeroDelayStreak = 0;
                }
                grantsSum += Math.max(grant, 0);
                lastGrant = Math.max(grant, 0);
                if (prevExpiry !== undefined) {
                  ctx.expiresAtMs = prevExpiry;
                }
                return;
              }
              fieldMode = false;
              zeroDelayStreak = 0;
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
            // Failure: KEEP pendingKey so any retry reuses the same
            // idempotency key. Permanent rejections (reservation gone,
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
            if (!fieldMode) {
              // FALLBACK: retry on the next beat at the current cadence.
              console.warn(
                `[runcycles] Heartbeat extend failed (status=${response.status}); retrying next beat: ${reservationId}`,
              );
              return;
            }
            // PRIMARY-path failure handling.
            if (response.status === 429) {
              const delay = fieldRecoveryDelayMs(
                response.retryAfterMsHeader,
                true,
              );
              if (delay === undefined) return; // stopped and surfaced
              nextDelayMs = delay;
              return;
            }
            if (response.isClientError) {
              // Any other 4xx: a request/authorization failure a retry of
              // the UNCHANGED request cannot fix — stop and surface;
              // never rotate the idempotency key to force it through.
              stopAndSurface(
                `extend rejected with client error (status=${response.status}, error=${String(errorCode)})`,
              );
              return;
            }
            if (!response.isTransportError && !response.isServerError) {
              stopAndSurface(
                `extend returned unexpected HTTP status ${response.status}`,
              );
              return;
            }
            // Timeout-as-response, transport-as-response, or 5xx.
            const delay = fieldRecoveryDelayMs(undefined, false);
            if (delay === undefined) return; // stopped and surfaced
            nextDelayMs = delay;
            console.warn(
              `[runcycles] Heartbeat extend failed (status=${response.status}); retrying with the same key in ${nextDelayMs}ms: ${reservationId}`,
            );
          })
          .catch((error: unknown) => {
            // Transport exception: preserve the same-key retry semantics, but
            // never make the loss of lease authority invisible to operators.
            const detail =
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error);
            if (fieldMode) {
              const delay = fieldRecoveryDelayMs(undefined, false);
              if (delay === undefined) {
                console.warn(
                  `[runcycles] Heartbeat extend transport error; recovery stopped: ${reservationId}: ${detail}`,
                );
                return; // stopped and surfaced
              }
              nextDelayMs = delay;
              console.warn(
                `[runcycles] Heartbeat extend transport error; retrying with the same key in ${nextDelayMs}ms: ${reservationId}: ${detail}`,
              );
            } else {
              console.warn(
                `[runcycles] Heartbeat extend transport error; retrying next beat with the same key in ${nextDelayMs}ms: ${reservationId}: ${detail}`,
              );
            }
          })
          .finally(() => {
            tick(nextDelayMs);
          });
      }, delayMs);
    };

    if (
      typeof createRemainingTtlMs === "number" &&
      Number.isInteger(createRemainingTtlMs) &&
      createRemainingTtlMs >= 0
    ) {
      // PRIMARY: the first beat derives from the create response's
      // remaining_ttl_ms with the same formula as every later beat,
      // using the create call's own measured rtt. No immediate prime:
      // under a maximum-lead clamp an immediate extend would only waste
      // one of max_extensions, and the exact schedule already lands the
      // first beat inside the real lease.
      fieldMode = true;
      const measuredLeadFloor = createLeadFloorAtScheduleStart(
        createRemainingTtlMs,
        createRttMs,
        createReceivedMono,
        anchor,
      );
      let leadFloor: number;
      if (measuredLeadFloor === undefined) {
        // Unknown timing must not be treated as zero elapsed time.
        leadFloor = 0;
      } else {
        maxObservedRttMs = Math.max(maxObservedRttMs, createRttMs);
        leadFloor = measuredLeadFloor;
      }
      lastLeadFloorMs = leadFloor;
      lastLeadFloorMono = anchor;
      const firstDelay = Math.max(0, Math.floor(leadFloor - retryReserveMs()));
      if (firstDelay === 0) {
        // The create response is the first zero-delay schema-valid
        // success: exactly one immediate fresh extension is permitted
        // before the two-consecutive-zero-delay guard stops the
        // heartbeat.
        zeroDelayStreak = 1;
      }
      tick(firstDelay);
    } else {
      // FALLBACK: immediate first beat — see the comment above
      // heldIntervalMs. The 0 delay applies to this first schedule ONLY:
      // every reschedule passes a delay that never becomes 0 (heuristic
      // reschedules use intervalMs, which starts at heldIntervalMs), so
      // a transient failure on the immediate first attempt never
      // hot-loops against a down server.
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
