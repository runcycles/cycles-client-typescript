import { describe, it, expect } from "vitest";
import { buildProtocolException } from "../src/errors.js";
import { CyclesResponse } from "../src/response.js";
import {
  BudgetExceededError,
  CyclesProtocolError,
  DebtOutstandingError,
  OverdraftLimitExceededError,
  ReservationExpiredError,
  ReservationFinalizedError,
} from "../src/exceptions.js";

describe("buildProtocolException", () => {
  it("returns BudgetExceededError for BUDGET_EXCEEDED", () => {
    const response = CyclesResponse.httpError(402, "Budget exceeded", {
      error: "BUDGET_EXCEEDED",
      message: "Insufficient budget",
      request_id: "req-1",
      details: { scope: "tenant:acme" },
    });

    const err = buildProtocolException("Failed", response);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.errorCode).toBe("BUDGET_EXCEEDED");
    expect(err.message).toBe("Failed: Insufficient budget");
    expect(err.requestId).toBe("req-1");
    expect(err.details).toEqual({ scope: "tenant:acme" });
  });

  it("returns OverdraftLimitExceededError for OVERDRAFT_LIMIT_EXCEEDED", () => {
    const response = CyclesResponse.httpError(402, "Overdraft", {
      error: "OVERDRAFT_LIMIT_EXCEEDED",
      message: "Overdraft limit exceeded",
      request_id: "req-2",
    });

    const err = buildProtocolException("Failed", response);
    expect(err).toBeInstanceOf(OverdraftLimitExceededError);
    expect(err.errorCode).toBe("OVERDRAFT_LIMIT_EXCEEDED");
  });

  it("returns DebtOutstandingError for DEBT_OUTSTANDING", () => {
    const response = CyclesResponse.httpError(402, "Debt", {
      error: "DEBT_OUTSTANDING",
      message: "Debt outstanding",
      request_id: "req-3",
    });

    const err = buildProtocolException("Failed", response);
    expect(err).toBeInstanceOf(DebtOutstandingError);
    expect(err.errorCode).toBe("DEBT_OUTSTANDING");
  });

  it("returns ReservationExpiredError for RESERVATION_EXPIRED", () => {
    const response = CyclesResponse.httpError(409, "Expired", {
      error: "RESERVATION_EXPIRED",
      message: "Reservation has expired",
      request_id: "req-4",
    });

    const err = buildProtocolException("Failed", response);
    expect(err).toBeInstanceOf(ReservationExpiredError);
    expect(err.errorCode).toBe("RESERVATION_EXPIRED");
  });

  it("returns ReservationFinalizedError for RESERVATION_FINALIZED", () => {
    const response = CyclesResponse.httpError(409, "Finalized", {
      error: "RESERVATION_FINALIZED",
      message: "Reservation already finalized",
      request_id: "req-5",
    });

    const err = buildProtocolException("Failed", response);
    expect(err).toBeInstanceOf(ReservationFinalizedError);
    expect(err.errorCode).toBe("RESERVATION_FINALIZED");
  });

  it("returns generic CyclesProtocolError for unknown error codes", () => {
    const response = CyclesResponse.httpError(400, "Bad request", {
      error: "INVALID_REQUEST",
      message: "Missing required field",
      request_id: "req-6",
    });

    const err = buildProtocolException("Failed", response);
    expect(err).toBeInstanceOf(CyclesProtocolError);
    expect(err).not.toBeInstanceOf(BudgetExceededError);
    expect(err.errorCode).toBe("INVALID_REQUEST");
  });

  it("falls back to body error attribute when getErrorResponse returns null", () => {
    // A success-shaped response with an error field in the body but no
    // structured error_response. This triggers the fallback path.
    const response = CyclesResponse.success(200, {
      error: "BUDGET_EXCEEDED",
      reason_code: "custom_reason",
    });

    const err = buildProtocolException("Denied", response);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.errorCode).toBe("BUDGET_EXCEEDED");
    expect(err.reasonCode).toBe("custom_reason");
  });

  it("parses retry_after_ms from response body", () => {
    const response = CyclesResponse.httpError(429, "Rate limited", {
      error: "BUDGET_EXCEEDED",
      message: "Try later",
      retry_after_ms: 5000,
    });

    const err = buildProtocolException("Failed", response);
    expect(err.retryAfterMs).toBe(5000);
  });

  it("defaults reasonCode to errorCode when reason_code absent", () => {
    const response = CyclesResponse.httpError(402, "Budget exceeded", {
      error: "BUDGET_EXCEEDED",
      message: "No budget",
    });

    const err = buildProtocolException("Failed", response);
    // reason_code is not in the body, so reasonCode falls back to errorCode
    expect(err.reasonCode).toBe("BUDGET_EXCEEDED");
  });

  it("appends errorMessage from response when error response lacks message field", () => {
    const response = CyclesResponse.httpError(500, "Server error", {
      error: "INTERNAL_ERROR",
    });

    const err = buildProtocolException("Something failed", response);
    // No structured error response (missing request_id), falls back to response.errorMessage
    expect(err.message).toBe("Something failed: Server error");
  });

  it("preserves status from response", () => {
    const response = CyclesResponse.httpError(503, "Unavailable", {
      error: "INTERNAL_ERROR",
      message: "Service down",
    });

    const err = buildProtocolException("Failed", response);
    expect(err.status).toBe(503);
  });

  it("handles transport error response", () => {
    const response = CyclesResponse.transportError(new Error("ECONNREFUSED"));

    const err = buildProtocolException("Connection failed", response);
    expect(err).toBeInstanceOf(CyclesProtocolError);
    expect(err.message).toBe("Connection failed: ECONNREFUSED");
    expect(err.status).toBe(-1);
  });
});
