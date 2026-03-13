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
