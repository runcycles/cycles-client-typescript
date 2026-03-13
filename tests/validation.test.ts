import { describe, it, expect } from "vitest";
import {
  validateSubject,
  validateReservationId,
  validateNonNegative,
  validateTtlMs,
  validateGracePeriodMs,
} from "../src/validation.js";

describe("validation", () => {
  describe("validateSubject", () => {
    it("passes with tenant", () => {
      expect(() => validateSubject({ tenant: "acme" })).not.toThrow();
    });

    it("passes with agent", () => {
      expect(() => validateSubject({ agent: "bot" })).not.toThrow();
    });

    it("throws with empty subject", () => {
      expect(() => validateSubject({})).toThrow("at least one standard field");
    });

    it("throws with only dimensions", () => {
      expect(() => validateSubject({ dimensions: { env: "prod" } })).toThrow("at least one standard field");
    });

    it("passes undefined", () => {
      expect(() => validateSubject(undefined)).not.toThrow();
    });
  });

  describe("validateReservationId", () => {
    it("passes with valid id", () => {
      expect(() => validateReservationId("r-123")).not.toThrow();
    });

    it("throws with empty string", () => {
      expect(() => validateReservationId("")).toThrow("required");
    });

    it("throws with undefined", () => {
      expect(() => validateReservationId(undefined)).toThrow("required");
    });
  });

  describe("validateNonNegative", () => {
    it("passes with zero", () => {
      expect(() => validateNonNegative(0, "estimate")).not.toThrow();
    });

    it("passes with positive", () => {
      expect(() => validateNonNegative(100, "estimate")).not.toThrow();
    });

    it("throws with negative", () => {
      expect(() => validateNonNegative(-1, "estimate")).toThrow("non-negative");
    });
  });

  describe("validateTtlMs", () => {
    it("passes with valid ttl", () => {
      expect(() => validateTtlMs(60_000)).not.toThrow();
    });

    it("throws with too low", () => {
      expect(() => validateTtlMs(500)).toThrow("between 1000");
    });

    it("throws with too high", () => {
      expect(() => validateTtlMs(100_000_000)).toThrow("between 1000");
    });
  });

  describe("validateGracePeriodMs", () => {
    it("passes undefined", () => {
      expect(() => validateGracePeriodMs(undefined)).not.toThrow();
    });

    it("passes valid", () => {
      expect(() => validateGracePeriodMs(5_000)).not.toThrow();
    });

    it("throws with negative", () => {
      expect(() => validateGracePeriodMs(-1)).toThrow("between 0");
    });

    it("throws with too high", () => {
      expect(() => validateGracePeriodMs(100_000)).toThrow("between 0");
    });
  });
});
