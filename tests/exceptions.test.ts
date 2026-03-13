import { describe, it, expect } from "vitest";
import {
  CyclesError,
  CyclesProtocolError,
  CyclesTransportError,
  BudgetExceededError,
  OverdraftLimitExceededError,
  DebtOutstandingError,
  ReservationExpiredError,
  ReservationFinalizedError,
} from "../src/exceptions.js";

describe("exceptions", () => {
  describe("CyclesProtocolError", () => {
    it("stores all properties", () => {
      const err = new CyclesProtocolError("test", {
        status: 400,
        errorCode: "BUDGET_EXCEEDED",
        reasonCode: "budget_exhausted",
        retryAfterMs: 5000,
        requestId: "req-1",
        details: { scope: "tenant" },
      });

      expect(err.message).toBe("test");
      expect(err.status).toBe(400);
      expect(err.errorCode).toBe("BUDGET_EXCEEDED");
      expect(err.reasonCode).toBe("budget_exhausted");
      expect(err.retryAfterMs).toBe(5000);
      expect(err.requestId).toBe("req-1");
      expect(err.details).toEqual({ scope: "tenant" });
    });

    it("helper methods", () => {
      const budget = new CyclesProtocolError("test", { errorCode: "BUDGET_EXCEEDED" });
      expect(budget.isBudgetExceeded()).toBe(true);
      expect(budget.isRetryable()).toBe(false);

      const internal = new CyclesProtocolError("test", { errorCode: "INTERNAL_ERROR", status: 500 });
      expect(internal.isRetryable()).toBe(true);

      const serverErr = new CyclesProtocolError("test", { status: 503 });
      expect(serverErr.isRetryable()).toBe(true);
    });
  });

  describe("subclasses", () => {
    it("BudgetExceededError is CyclesProtocolError", () => {
      const err = new BudgetExceededError("budget exceeded");
      expect(err).toBeInstanceOf(CyclesProtocolError);
      expect(err).toBeInstanceOf(CyclesError);
      expect(err.name).toBe("BudgetExceededError");
    });

    it("all subclasses extend CyclesProtocolError", () => {
      expect(new OverdraftLimitExceededError("test")).toBeInstanceOf(CyclesProtocolError);
      expect(new DebtOutstandingError("test")).toBeInstanceOf(CyclesProtocolError);
      expect(new ReservationExpiredError("test")).toBeInstanceOf(CyclesProtocolError);
      expect(new ReservationFinalizedError("test")).toBeInstanceOf(CyclesProtocolError);
    });
  });

  describe("helper methods on CyclesProtocolError", () => {
    it("isOverdraftLimitExceeded returns true for matching code", () => {
      const err = new CyclesProtocolError("test", { errorCode: "OVERDRAFT_LIMIT_EXCEEDED" });
      expect(err.isOverdraftLimitExceeded()).toBe(true);
      expect(err.isBudgetExceeded()).toBe(false);
    });

    it("isDebtOutstanding returns true for matching code", () => {
      const err = new CyclesProtocolError("test", { errorCode: "DEBT_OUTSTANDING" });
      expect(err.isDebtOutstanding()).toBe(true);
      expect(err.isBudgetExceeded()).toBe(false);
    });

    it("isReservationExpired returns true for matching code", () => {
      const err = new CyclesProtocolError("test", { errorCode: "RESERVATION_EXPIRED" });
      expect(err.isReservationExpired()).toBe(true);
      expect(err.isReservationFinalized()).toBe(false);
    });

    it("isReservationFinalized returns true for matching code", () => {
      const err = new CyclesProtocolError("test", { errorCode: "RESERVATION_FINALIZED" });
      expect(err.isReservationFinalized()).toBe(true);
      expect(err.isReservationExpired()).toBe(false);
    });

    it("isIdempotencyMismatch returns true for matching code", () => {
      const err = new CyclesProtocolError("test", { errorCode: "IDEMPOTENCY_MISMATCH" });
      expect(err.isIdempotencyMismatch()).toBe(true);
    });

    it("isUnitMismatch returns true for matching code", () => {
      const err = new CyclesProtocolError("test", { errorCode: "UNIT_MISMATCH" });
      expect(err.isUnitMismatch()).toBe(true);
    });

    it("all helpers return false for non-matching error code", () => {
      const err = new CyclesProtocolError("test", { errorCode: "UNKNOWN" });
      expect(err.isBudgetExceeded()).toBe(false);
      expect(err.isOverdraftLimitExceeded()).toBe(false);
      expect(err.isDebtOutstanding()).toBe(false);
      expect(err.isReservationExpired()).toBe(false);
      expect(err.isReservationFinalized()).toBe(false);
      expect(err.isIdempotencyMismatch()).toBe(false);
      expect(err.isUnitMismatch()).toBe(false);
      expect(err.isRetryable()).toBe(true); // UNKNOWN is retryable
    });
  });

  describe("CyclesTransportError", () => {
    it("stores cause", () => {
      const cause = new Error("ECONNREFUSED");
      const err = new CyclesTransportError("connection failed", { cause });
      expect(err).toBeInstanceOf(CyclesError);
      expect(err.cause).toBe(cause);
      expect(err.name).toBe("CyclesTransportError");
    });
  });
});
