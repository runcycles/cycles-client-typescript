import { describe, it, expect } from "vitest";
import {
  Unit,
  Decision,
  ErrorCode,
  isAllowed,
  isDenied,
  isRetryableErrorCode,
  errorCodeFromString,
  isToolAllowed,
  isMetricsEmpty,
} from "../src/models.js";
import type { Caps, CyclesMetrics } from "../src/models.js";

describe("models", () => {
  describe("isAllowed/isDenied", () => {
    it("ALLOW is allowed", () => {
      expect(isAllowed(Decision.ALLOW)).toBe(true);
      expect(isDenied(Decision.ALLOW)).toBe(false);
    });

    it("ALLOW_WITH_CAPS is allowed", () => {
      expect(isAllowed(Decision.ALLOW_WITH_CAPS)).toBe(true);
      expect(isDenied(Decision.ALLOW_WITH_CAPS)).toBe(false);
    });

    it("DENY is denied", () => {
      expect(isAllowed(Decision.DENY)).toBe(false);
      expect(isDenied(Decision.DENY)).toBe(true);
    });
  });

  describe("isRetryableErrorCode", () => {
    it("INTERNAL_ERROR is retryable", () => {
      expect(isRetryableErrorCode(ErrorCode.INTERNAL_ERROR)).toBe(true);
    });

    it("UNKNOWN is retryable", () => {
      expect(isRetryableErrorCode(ErrorCode.UNKNOWN)).toBe(true);
    });

    it("BUDGET_EXCEEDED is not retryable", () => {
      expect(isRetryableErrorCode(ErrorCode.BUDGET_EXCEEDED)).toBe(false);
    });
  });

  describe("errorCodeFromString", () => {
    it("returns known code", () => {
      expect(errorCodeFromString("BUDGET_EXCEEDED")).toBe(ErrorCode.BUDGET_EXCEEDED);
    });

    it("returns UNKNOWN for unrecognized", () => {
      expect(errorCodeFromString("SOMETHING_ELSE")).toBe(ErrorCode.UNKNOWN);
    });

    it("returns undefined for undefined", () => {
      expect(errorCodeFromString(undefined)).toBeUndefined();
    });
  });

  describe("isToolAllowed", () => {
    it("allows when no lists", () => {
      const caps: Caps = {};
      expect(isToolAllowed(caps, "search")).toBe(true);
    });

    it("respects allowlist", () => {
      const caps: Caps = { toolAllowlist: ["search", "browse"] };
      expect(isToolAllowed(caps, "search")).toBe(true);
      expect(isToolAllowed(caps, "delete")).toBe(false);
    });

    it("respects denylist", () => {
      const caps: Caps = { toolDenylist: ["delete"] };
      expect(isToolAllowed(caps, "search")).toBe(true);
      expect(isToolAllowed(caps, "delete")).toBe(false);
    });

    it("empty allowlist falls through to denylist", () => {
      const caps: Caps = { toolAllowlist: [], toolDenylist: ["delete"] };
      expect(isToolAllowed(caps, "search")).toBe(true);
      expect(isToolAllowed(caps, "delete")).toBe(false);
    });

    it("empty allowlist and empty denylist allows all", () => {
      const caps: Caps = { toolAllowlist: [], toolDenylist: [] };
      expect(isToolAllowed(caps, "anything")).toBe(true);
    });

    it("allowlist takes precedence over denylist", () => {
      const caps: Caps = { toolAllowlist: ["search"], toolDenylist: ["search"] };
      expect(isToolAllowed(caps, "search")).toBe(true);
      expect(isToolAllowed(caps, "delete")).toBe(false);
    });
  });

  describe("isMetricsEmpty", () => {
    it("empty metrics", () => {
      expect(isMetricsEmpty({})).toBe(true);
    });

    it("non-empty metrics", () => {
      expect(isMetricsEmpty({ tokensInput: 100 })).toBe(false);
    });
  });

  describe("enum values", () => {
    it("Unit values", () => {
      expect(Unit.USD_MICROCENTS).toBe("USD_MICROCENTS");
      expect(Unit.TOKENS).toBe("TOKENS");
    });
  });
});
