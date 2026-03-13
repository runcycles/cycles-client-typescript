/**
 * Explicit request/response mappers between camelCase TypeScript interfaces
 * and snake_case wire format.
 *
 * These are intentionally verbose — each field is mapped individually so that
 * protocol drift is immediately visible, special cases are handled explicitly,
 * and the wire contract is auditable.
 */

import type {
  Amount,
  Balance,
  Caps,
  CyclesMetrics,
  ReservationCreateResponse,
  SignedAmount,
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
