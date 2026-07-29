/** Strict terminal-success validation for spend settlement responses. */

import type { CyclesResponse } from "./response.js";

const UNITS = new Set([
  "USD_MICROCENTS",
  "TOKENS",
  "CREDITS",
  "RISK_POINTS",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isAmount(value: unknown, signed = false): boolean {
  return (
    isObject(value) &&
    hasExactKeys(value, ["unit", "amount"], []) &&
    typeof value.unit === "string" &&
    UNITS.has(value.unit) &&
    isInteger(value.amount) &&
    (signed || value.amount >= 0)
  );
}

function isEvidenceRef(value: unknown): boolean {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["evidence_id", "cycles_evidence_url"], []) ||
    typeof value.evidence_id !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.evidence_id) ||
    typeof value.cycles_evidence_url !== "string"
  ) {
    return false;
  }
  try {
    return new URL(value.cycles_evidence_url).protocol.length > 1;
  } catch {
    return false;
  }
}

function isBalance(value: unknown): boolean {
  if (
    !isObject(value) ||
    !hasExactKeys(
      value,
      ["scope", "scope_path", "remaining"],
      [
        "reserved",
        "spent",
        "allocated",
        "debt",
        "overdraft_limit",
        "is_over_limit",
      ],
    ) ||
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
  ]) {
    if (value[key] !== undefined && !isAmount(value[key])) return false;
  }
  return (
    value.is_over_limit === undefined ||
    typeof value.is_over_limit === "boolean"
  );
}

function hasValidBalances(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((balance) => isBalance(balance)))
  );
}

export function isSchemaValidCommitSuccess(response: CyclesResponse): boolean {
  const body = response.body;
  return (
    response.status === 200 &&
    isObject(body) &&
    hasExactKeys(
      body,
      ["status", "charged"],
      ["released", "balances", "cycles_evidence"],
    ) &&
    body.status === "COMMITTED" &&
    isAmount(body.charged) &&
    (body.released === undefined || isAmount(body.released)) &&
    hasValidBalances(body.balances) &&
    (body.cycles_evidence === undefined ||
      isEvidenceRef(body.cycles_evidence))
  );
}

export function isSchemaValidEventSuccess(response: CyclesResponse): boolean {
  const body = response.body;
  return (
    response.status === 201 &&
    isObject(body) &&
    hasExactKeys(body, ["status", "event_id"], ["charged", "balances"]) &&
    body.status === "APPLIED" &&
    typeof body.event_id === "string" &&
    (body.charged === undefined || isAmount(body.charged)) &&
    hasValidBalances(body.balances)
  );
}
