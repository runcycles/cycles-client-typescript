/**
 * Explicit request/response mappers between camelCase TypeScript interfaces
 * and snake_case wire format.
 *
 * These are intentionally verbose — each field is mapped individually so that
 * protocol drift is immediately visible, special cases are handled explicitly,
 * and the wire contract is auditable.
 */

import type {
  Action,
  Amount,
  Balance,
  BalanceResponse,
  Caps,
  CommitRequest,
  CommitResponse,
  CyclesMetrics,
  DecisionRequest,
  DecisionResponse,
  EventCreateRequest,
  EventCreateResponse,
  ReleaseRequest,
  ReleaseResponse,
  ReservationCreateRequest,
  ReservationCreateResponse,
  ReservationDetail,
  ReservationExtendRequest,
  ReservationExtendResponse,
  ReservationListResponse,
  ReservationSummary,
  SignedAmount,
  Subject,
} from "./models.js";

// --- Request mappers (camelCase → snake_case wire format) ---

/** Strip undefined values from an object (mirrors Pydantic's exclude_none). */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export function metricsToWire(
  metrics: CyclesMetrics,
): Record<string, unknown> {
  return stripUndefined({
    tokens_input: metrics.tokensInput,
    tokens_output: metrics.tokensOutput,
    latency_ms: metrics.latencyMs,
    model_version: metrics.modelVersion,
    custom: metrics.custom,
  });
}

// --- Response mappers (snake_case wire format → camelCase) ---

export function capsFromWire(
  wire: Record<string, unknown> | undefined,
): Caps | undefined {
  if (!wire) return undefined;
  return stripUndefined({
    maxTokens: wire.max_tokens,
    maxStepsRemaining: wire.max_steps_remaining,
    toolAllowlist: wire.tool_allowlist,
    toolDenylist: wire.tool_denylist,
    cooldownMs: wire.cooldown_ms,
  }) as Caps;
}

function amountFromWire(
  wire: Record<string, unknown> | undefined,
): Amount | undefined {
  if (!wire) return undefined;
  return { unit: wire.unit as string, amount: wire.amount as number };
}

function signedAmountFromWire(
  wire: Record<string, unknown> | undefined,
): SignedAmount | undefined {
  if (!wire) return undefined;
  return { unit: wire.unit as string, amount: wire.amount as number };
}

function balanceFromWire(
  wire: Record<string, unknown>,
): Balance {
  return {
    scope: wire.scope as string,
    scopePath: wire.scope_path as string,
    remaining: signedAmountFromWire(wire.remaining as Record<string, unknown>)!,
    reserved: amountFromWire(wire.reserved as Record<string, unknown> | undefined),
    spent: amountFromWire(wire.spent as Record<string, unknown> | undefined),
    allocated: amountFromWire(wire.allocated as Record<string, unknown> | undefined),
    debt: amountFromWire(wire.debt as Record<string, unknown> | undefined),
    overdraftLimit: amountFromWire(wire.overdraft_limit as Record<string, unknown> | undefined),
    isOverLimit: wire.is_over_limit as boolean | undefined,
  };
}

function balancesFromWire(
  wire: unknown[] | undefined,
): Balance[] | undefined {
  if (!wire) return undefined;
  return wire.map((b) => balanceFromWire(b as Record<string, unknown>));
}

export function reservationCreateResponseFromWire(
  wire: Record<string, unknown>,
): ReservationCreateResponse {
  return {
    decision: wire.decision as ReservationCreateResponse["decision"],
    reservationId: wire.reservation_id as string | undefined,
    affectedScopes: (wire.affected_scopes as string[] | undefined) ?? [],
    expiresAtMs: wire.expires_at_ms as number | undefined,
    scopePath: wire.scope_path as string | undefined,
    reserved: amountFromWire(wire.reserved as Record<string, unknown> | undefined),
    caps: capsFromWire(wire.caps as Record<string, unknown> | undefined),
    reasonCode: wire.reason_code as string | undefined,
    retryAfterMs: wire.retry_after_ms as number | undefined,
    balances: balancesFromWire(wire.balances as unknown[] | undefined),
  };
}

export function commitResponseFromWire(
  wire: Record<string, unknown>,
): CommitResponse {
  return {
    status: wire.status as CommitResponse["status"],
    charged: amountFromWire(wire.charged as Record<string, unknown>)!,
    released: amountFromWire(wire.released as Record<string, unknown> | undefined),
    balances: balancesFromWire(wire.balances as unknown[] | undefined),
  };
}

export function releaseResponseFromWire(
  wire: Record<string, unknown>,
): ReleaseResponse {
  return {
    status: wire.status as ReleaseResponse["status"],
    released: amountFromWire(wire.released as Record<string, unknown>)!,
    balances: balancesFromWire(wire.balances as unknown[] | undefined),
  };
}

export function reservationExtendResponseFromWire(
  wire: Record<string, unknown>,
): ReservationExtendResponse {
  return {
    status: wire.status as ReservationExtendResponse["status"],
    expiresAtMs: wire.expires_at_ms as number,
    balances: balancesFromWire(wire.balances as unknown[] | undefined),
  };
}

export function decisionResponseFromWire(
  wire: Record<string, unknown>,
): DecisionResponse {
  return stripUndefined({
    decision: wire.decision,
    caps: capsFromWire(wire.caps as Record<string, unknown> | undefined),
    reasonCode: wire.reason_code,
    retryAfterMs: wire.retry_after_ms,
    affectedScopes: wire.affected_scopes,
  }) as unknown as DecisionResponse;
}

export function eventCreateResponseFromWire(
  wire: Record<string, unknown>,
): EventCreateResponse {
  return {
    status: wire.status as EventCreateResponse["status"],
    eventId: wire.event_id as string,
    balances: balancesFromWire(wire.balances as unknown[] | undefined),
  };
}

function subjectFromWire(
  wire: Record<string, unknown>,
): Subject {
  const result: Subject = {};
  if (wire.tenant !== undefined) result.tenant = wire.tenant as string;
  if (wire.workspace !== undefined) result.workspace = wire.workspace as string;
  if (wire.app !== undefined) result.app = wire.app as string;
  if (wire.workflow !== undefined) result.workflow = wire.workflow as string;
  if (wire.agent !== undefined) result.agent = wire.agent as string;
  if (wire.toolset !== undefined) result.toolset = wire.toolset as string;
  if (wire.dimensions !== undefined) result.dimensions = wire.dimensions as Record<string, string>;
  return result;
}

function actionFromWire(
  wire: Record<string, unknown>,
): Action {
  const result: Action = {
    kind: wire.kind as string,
    name: wire.name as string,
  };
  if (wire.tags !== undefined) result.tags = wire.tags as string[];
  return result;
}

export function reservationDetailFromWire(
  wire: Record<string, unknown>,
): ReservationDetail {
  return {
    reservationId: wire.reservation_id as string,
    status: wire.status as ReservationDetail["status"],
    subject: subjectFromWire(wire.subject as Record<string, unknown>),
    action: actionFromWire(wire.action as Record<string, unknown>),
    reserved: amountFromWire(wire.reserved as Record<string, unknown>)!,
    createdAtMs: wire.created_at_ms as number,
    expiresAtMs: wire.expires_at_ms as number,
    scopePath: wire.scope_path as string,
    affectedScopes: wire.affected_scopes as string[],
    idempotencyKey: wire.idempotency_key as string | undefined,
    committed: amountFromWire(wire.committed as Record<string, unknown> | undefined),
    finalizedAtMs: wire.finalized_at_ms as number | undefined,
    metadata: wire.metadata as Record<string, unknown> | undefined,
  };
}

export function reservationSummaryFromWire(
  wire: Record<string, unknown>,
): ReservationSummary {
  return {
    reservationId: wire.reservation_id as string,
    status: wire.status as ReservationSummary["status"],
    subject: subjectFromWire(wire.subject as Record<string, unknown>),
    action: actionFromWire(wire.action as Record<string, unknown>),
    reserved: amountFromWire(wire.reserved as Record<string, unknown>)!,
    createdAtMs: wire.created_at_ms as number,
    expiresAtMs: wire.expires_at_ms as number,
    scopePath: wire.scope_path as string,
    affectedScopes: wire.affected_scopes as string[],
    idempotencyKey: wire.idempotency_key as string | undefined,
  };
}

export function reservationListResponseFromWire(
  wire: Record<string, unknown>,
): ReservationListResponse {
  const reservations = (wire.reservations as unknown[]).map(
    (r) => reservationSummaryFromWire(r as Record<string, unknown>),
  );
  return {
    reservations,
    nextCursor: wire.next_cursor as string | undefined,
    hasMore: wire.has_more as boolean | undefined,
  };
}

export function balanceResponseFromWire(
  wire: Record<string, unknown>,
): BalanceResponse {
  return {
    balances: balancesFromWire(wire.balances as unknown[]) ?? [],
    nextCursor: wire.next_cursor as string | undefined,
    hasMore: wire.has_more as boolean | undefined,
  };
}

export function errorResponseFromWire(
  wire: Record<string, unknown>,
): { error: string; message: string; requestId: string; details?: Record<string, unknown> } | undefined {
  if (
    typeof wire.error !== "string" ||
    typeof wire.message !== "string" ||
    typeof wire.request_id !== "string"
  ) {
    return undefined;
  }
  return {
    error: wire.error,
    message: wire.message,
    requestId: wire.request_id,
    details: wire.details as Record<string, unknown> | undefined,
  };
}

// --- Request mappers (camelCase → snake_case wire format) ---

function actionToWire(action: Action): Record<string, unknown> {
  return stripUndefined({
    kind: action.kind,
    name: action.name,
    tags: action.tags,
  });
}

function subjectToWire(subject: Subject): Record<string, unknown> {
  return stripUndefined({
    tenant: subject.tenant,
    workspace: subject.workspace,
    app: subject.app,
    workflow: subject.workflow,
    agent: subject.agent,
    toolset: subject.toolset,
    dimensions: subject.dimensions,
  });
}

export function reservationCreateRequestToWire(
  req: ReservationCreateRequest,
): Record<string, unknown> {
  return stripUndefined({
    idempotency_key: req.idempotencyKey,
    subject: subjectToWire(req.subject),
    action: actionToWire(req.action),
    estimate: req.estimate,
    ttl_ms: req.ttlMs,
    grace_period_ms: req.gracePeriodMs,
    overage_policy: req.overagePolicy,
    dry_run: req.dryRun,
    metadata: req.metadata,
  });
}

export function commitRequestToWire(
  req: CommitRequest,
): Record<string, unknown> {
  return stripUndefined({
    idempotency_key: req.idempotencyKey,
    actual: req.actual,
    metrics: req.metrics ? metricsToWire(req.metrics) : undefined,
    metadata: req.metadata,
  });
}

export function releaseRequestToWire(
  req: ReleaseRequest,
): Record<string, unknown> {
  return stripUndefined({
    idempotency_key: req.idempotencyKey,
    reason: req.reason,
  });
}

export function reservationExtendRequestToWire(
  req: ReservationExtendRequest,
): Record<string, unknown> {
  return stripUndefined({
    idempotency_key: req.idempotencyKey,
    extend_by_ms: req.extendByMs,
    metadata: req.metadata,
  });
}

export function decisionRequestToWire(
  req: DecisionRequest,
): Record<string, unknown> {
  return stripUndefined({
    idempotency_key: req.idempotencyKey,
    subject: subjectToWire(req.subject),
    action: actionToWire(req.action),
    estimate: req.estimate,
    metadata: req.metadata,
  });
}

export function eventCreateRequestToWire(
  req: EventCreateRequest,
): Record<string, unknown> {
  return stripUndefined({
    idempotency_key: req.idempotencyKey,
    subject: subjectToWire(req.subject),
    action: actionToWire(req.action),
    actual: req.actual,
    overage_policy: req.overagePolicy,
    metrics: req.metrics ? metricsToWire(req.metrics) : undefined,
    client_time_ms: req.clientTimeMs,
    metadata: req.metadata,
  });
}
