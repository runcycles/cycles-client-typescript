/**
 * Shared utility for building typed protocol exceptions from CyclesResponse.
 *
 * Used by both lifecycle.ts and streaming.ts to avoid duplicating the
 * error-code-to-exception mapping logic.
 */

import {
  BudgetExceededError,
  CyclesProtocolError,
  DebtOutstandingError,
  OverdraftLimitExceededError,
  ReservationExpiredError,
  ReservationFinalizedError,
} from "./exceptions.js";
import type { CyclesResponse } from "./response.js";

export function buildProtocolException(
  prefix: string,
  response: CyclesResponse,
): CyclesProtocolError {
  const errorResp = response.getErrorResponse();
  let errorCode: string | undefined;
  let reasonCode: string | undefined;
  let message = prefix;
  let requestId: string | undefined;
  let details: Record<string, unknown> | undefined;

  if (errorResp) {
    errorCode = errorResp.error;
    requestId = errorResp.requestId;
    details = errorResp.details;
    if (errorResp.message) {
      message = `${prefix}: ${errorResp.message}`;
    }
  } else {
    const rawError = response.getBodyAttribute("error");
    if (typeof rawError === "string") {
      errorCode = rawError;
    }
    if (response.errorMessage) {
      message = `${prefix}: ${response.errorMessage}`;
    }
  }

  // Wire-format keys
  reasonCode = response.getBodyAttribute("reason_code") as string | undefined;
  if (reasonCode === undefined && errorCode !== undefined) {
    reasonCode = errorCode;
  }

  const retryRaw = response.getBodyAttribute("retry_after_ms");
  const retryAfterMs = retryRaw !== undefined ? Number(retryRaw) : undefined;

  const opts = {
    status: response.status,
    errorCode,
    reasonCode,
    retryAfterMs,
    requestId,
    details,
  };

  switch (errorCode) {
    case "BUDGET_EXCEEDED":
      return new BudgetExceededError(message, opts);
    case "OVERDRAFT_LIMIT_EXCEEDED":
      return new OverdraftLimitExceededError(message, opts);
    case "DEBT_OUTSTANDING":
      return new DebtOutstandingError(message, opts);
    case "RESERVATION_EXPIRED":
      return new ReservationExpiredError(message, opts);
    case "RESERVATION_FINALIZED":
      return new ReservationFinalizedError(message, opts);
    default:
      return new CyclesProtocolError(message, opts);
  }
}
