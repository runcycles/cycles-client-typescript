import { describe, it, expect } from "vitest";
import {
  metricsToWire,
  capsFromWire,
  reservationCreateResponseFromWire,
  errorResponseFromWire,
} from "../src/mappers.js";

describe("metricsToWire", () => {
  it("converts camelCase metrics to snake_case wire format", () => {
    const wire = metricsToWire({
      tokensInput: 100,
      tokensOutput: 200,
      latencyMs: 500,
      modelVersion: "gpt-4o",
    });
    expect(wire).toEqual({
      tokens_input: 100,
      tokens_output: 200,
      latency_ms: 500,
      model_version: "gpt-4o",
    });
  });

  it("strips undefined values", () => {
    const wire = metricsToWire({ tokensInput: 100 });
    expect(wire).toEqual({ tokens_input: 100 });
    expect("tokens_output" in wire).toBe(false);
  });

  it("includes custom field", () => {
    const wire = metricsToWire({ custom: { provider: "openai" } });
    expect(wire).toEqual({ custom: { provider: "openai" } });
  });
});

describe("capsFromWire", () => {
  it("converts snake_case wire caps to camelCase", () => {
    const caps = capsFromWire({
      max_tokens: 4096,
      max_steps_remaining: 3,
      tool_allowlist: ["search"],
      cooldown_ms: 1000,
    });
    expect(caps).toEqual({
      maxTokens: 4096,
      maxStepsRemaining: 3,
      toolAllowlist: ["search"],
      cooldownMs: 1000,
    });
  });

  it("returns undefined for undefined input", () => {
    expect(capsFromWire(undefined)).toBeUndefined();
  });
});

describe("reservationCreateResponseFromWire", () => {
  it("converts full wire response", () => {
    const parsed = reservationCreateResponseFromWire({
      decision: "ALLOW",
      reservation_id: "r-1",
      affected_scopes: ["tenant:acme"],
      expires_at_ms: 9999999,
      scope_path: "/acme",
      reserved: { unit: "USD_MICROCENTS", amount: 1000 },
      caps: { max_tokens: 4096 },
      reason_code: "BUDGET_OK",
      retry_after_ms: undefined,
      balances: [
        {
          scope: "tenant:acme",
          scope_path: "/acme",
          remaining: { unit: "USD_MICROCENTS", amount: 5000 },
        },
      ],
    });

    expect(parsed.decision).toBe("ALLOW");
    expect(parsed.reservationId).toBe("r-1");
    expect(parsed.affectedScopes).toEqual(["tenant:acme"]);
    expect(parsed.expiresAtMs).toBe(9999999);
    expect(parsed.scopePath).toBe("/acme");
    expect(parsed.reserved).toEqual({ unit: "USD_MICROCENTS", amount: 1000 });
    expect(parsed.caps).toEqual({ maxTokens: 4096 });
    expect(parsed.reasonCode).toBe("BUDGET_OK");
    expect(parsed.balances).toHaveLength(1);
    expect(parsed.balances![0].scopePath).toBe("/acme");
  });

  it("handles minimal DENY response", () => {
    const parsed = reservationCreateResponseFromWire({
      decision: "DENY",
      affected_scopes: [],
      reason_code: "BUDGET_EXCEEDED",
    });
    expect(parsed.decision).toBe("DENY");
    expect(parsed.reservationId).toBeUndefined();
    expect(parsed.caps).toBeUndefined();
  });

  it("defaults affectedScopes to empty array when missing", () => {
    const parsed = reservationCreateResponseFromWire({
      decision: "ALLOW",
      reservation_id: "r-1",
    });
    expect(parsed.affectedScopes).toEqual([]);
  });
});

describe("errorResponseFromWire", () => {
  it("parses wire-format error", () => {
    const result = errorResponseFromWire({
      error: "INVALID_REQUEST",
      message: "Missing field",
      request_id: "req-1",
      details: { field: "tenant" },
    });
    expect(result).toEqual({
      error: "INVALID_REQUEST",
      message: "Missing field",
      requestId: "req-1",
      details: { field: "tenant" },
    });
  });

  it("returns undefined for incomplete body", () => {
    expect(errorResponseFromWire({ error: "FOO" })).toBeUndefined();
    expect(errorResponseFromWire({ error: "FOO", message: "bar" })).toBeUndefined();
  });
});
