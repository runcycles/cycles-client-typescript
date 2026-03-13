import { describe, it, expect } from "vitest";
import {
  metricsToWire,
  capsFromWire,
  reservationCreateResponseFromWire,
  commitResponseFromWire,
  releaseResponseFromWire,
  reservationExtendResponseFromWire,
  decisionResponseFromWire,
  eventCreateResponseFromWire,
  reservationDetailFromWire,
  reservationSummaryFromWire,
  reservationListResponseFromWire,
  balanceResponseFromWire,
  errorResponseFromWire,
  reservationCreateRequestToWire,
  commitRequestToWire,
  releaseRequestToWire,
  reservationExtendRequestToWire,
  decisionRequestToWire,
  eventCreateRequestToWire,
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

// --- New response-from-wire mappers ---

describe("commitResponseFromWire", () => {
  it("converts full wire response", () => {
    const parsed = commitResponseFromWire({
      status: "COMMITTED",
      charged: { unit: "USD_MICROCENTS", amount: 500 },
      released: { unit: "USD_MICROCENTS", amount: 200 },
      balances: [
        {
          scope: "tenant:acme",
          scope_path: "/acme",
          remaining: { unit: "USD_MICROCENTS", amount: 4300 },
        },
      ],
    });
    expect(parsed.status).toBe("COMMITTED");
    expect(parsed.charged).toEqual({ unit: "USD_MICROCENTS", amount: 500 });
    expect(parsed.released).toEqual({ unit: "USD_MICROCENTS", amount: 200 });
    expect(parsed.balances).toHaveLength(1);
  });

  it("handles response without released or balances", () => {
    const parsed = commitResponseFromWire({
      status: "COMMITTED",
      charged: { unit: "TOKENS", amount: 100 },
    });
    expect(parsed.status).toBe("COMMITTED");
    expect(parsed.charged).toEqual({ unit: "TOKENS", amount: 100 });
    expect(parsed.released).toBeUndefined();
    expect(parsed.balances).toBeUndefined();
  });
});

describe("releaseResponseFromWire", () => {
  it("converts full wire response", () => {
    const parsed = releaseResponseFromWire({
      status: "RELEASED",
      released: { unit: "USD_MICROCENTS", amount: 1000 },
      balances: [
        {
          scope: "tenant:acme",
          scope_path: "/acme",
          remaining: { unit: "USD_MICROCENTS", amount: 6000 },
        },
      ],
    });
    expect(parsed.status).toBe("RELEASED");
    expect(parsed.released).toEqual({ unit: "USD_MICROCENTS", amount: 1000 });
    expect(parsed.balances).toHaveLength(1);
  });

  it("handles response without balances", () => {
    const parsed = releaseResponseFromWire({
      status: "RELEASED",
      released: { unit: "TOKENS", amount: 50 },
    });
    expect(parsed.balances).toBeUndefined();
  });
});

describe("reservationExtendResponseFromWire", () => {
  it("converts full wire response", () => {
    const parsed = reservationExtendResponseFromWire({
      status: "ACTIVE",
      expires_at_ms: 1700000000000,
      balances: [
        {
          scope: "tenant:acme",
          scope_path: "/acme",
          remaining: { unit: "USD_MICROCENTS", amount: 5000 },
        },
      ],
    });
    expect(parsed.status).toBe("ACTIVE");
    expect(parsed.expiresAtMs).toBe(1700000000000);
    expect(parsed.balances).toHaveLength(1);
  });

  it("handles response without balances", () => {
    const parsed = reservationExtendResponseFromWire({
      status: "ACTIVE",
      expires_at_ms: 9999,
    });
    expect(parsed.expiresAtMs).toBe(9999);
    expect(parsed.balances).toBeUndefined();
  });
});

describe("decisionResponseFromWire", () => {
  it("converts ALLOW response", () => {
    const parsed = decisionResponseFromWire({
      decision: "ALLOW",
      affected_scopes: ["tenant:acme", "app:myapp"],
    });
    expect(parsed.decision).toBe("ALLOW");
    expect(parsed.affectedScopes).toEqual(["tenant:acme", "app:myapp"]);
    expect(parsed.caps).toBeUndefined();
  });

  it("converts ALLOW_WITH_CAPS response", () => {
    const parsed = decisionResponseFromWire({
      decision: "ALLOW_WITH_CAPS",
      caps: { max_tokens: 2048, cooldown_ms: 500 },
      affected_scopes: ["tenant:acme"],
    });
    expect(parsed.decision).toBe("ALLOW_WITH_CAPS");
    expect(parsed.caps).toEqual({ maxTokens: 2048, cooldownMs: 500 });
  });

  it("converts DENY response with reason_code and retry_after_ms", () => {
    const parsed = decisionResponseFromWire({
      decision: "DENY",
      reason_code: "BUDGET_EXCEEDED",
      retry_after_ms: 5000,
    });
    expect(parsed.decision).toBe("DENY");
    expect(parsed.reasonCode).toBe("BUDGET_EXCEEDED");
    expect(parsed.retryAfterMs).toBe(5000);
  });
});

describe("eventCreateResponseFromWire", () => {
  it("converts full wire response", () => {
    const parsed = eventCreateResponseFromWire({
      status: "APPLIED",
      event_id: "evt-123",
      balances: [
        {
          scope: "tenant:acme",
          scope_path: "/acme",
          remaining: { unit: "USD_MICROCENTS", amount: 3000 },
        },
      ],
    });
    expect(parsed.status).toBe("APPLIED");
    expect(parsed.eventId).toBe("evt-123");
    expect(parsed.balances).toHaveLength(1);
  });

  it("handles response without balances", () => {
    const parsed = eventCreateResponseFromWire({
      status: "APPLIED",
      event_id: "evt-456",
    });
    expect(parsed.eventId).toBe("evt-456");
    expect(parsed.balances).toBeUndefined();
  });
});

describe("reservationDetailFromWire", () => {
  it("converts full wire response with all fields", () => {
    const parsed = reservationDetailFromWire({
      reservation_id: "r-1",
      status: "COMMITTED",
      subject: { tenant: "acme", app: "myapp" },
      action: { kind: "llm.completion", name: "openai:gpt-4o", tags: ["prod"] },
      reserved: { unit: "USD_MICROCENTS", amount: 1000 },
      created_at_ms: 1700000000000,
      expires_at_ms: 1700000060000,
      scope_path: "/acme/myapp",
      affected_scopes: ["tenant:acme", "app:myapp"],
      idempotency_key: "key-1",
      committed: { unit: "USD_MICROCENTS", amount: 800 },
      finalized_at_ms: 1700000050000,
      metadata: { run_id: "run-1" },
    });
    expect(parsed.reservationId).toBe("r-1");
    expect(parsed.status).toBe("COMMITTED");
    expect(parsed.subject).toEqual({ tenant: "acme", app: "myapp" });
    expect(parsed.action).toEqual({ kind: "llm.completion", name: "openai:gpt-4o", tags: ["prod"] });
    expect(parsed.reserved).toEqual({ unit: "USD_MICROCENTS", amount: 1000 });
    expect(parsed.createdAtMs).toBe(1700000000000);
    expect(parsed.expiresAtMs).toBe(1700000060000);
    expect(parsed.scopePath).toBe("/acme/myapp");
    expect(parsed.affectedScopes).toEqual(["tenant:acme", "app:myapp"]);
    expect(parsed.idempotencyKey).toBe("key-1");
    expect(parsed.committed).toEqual({ unit: "USD_MICROCENTS", amount: 800 });
    expect(parsed.finalizedAtMs).toBe(1700000050000);
    expect(parsed.metadata).toEqual({ run_id: "run-1" });
  });

  it("handles minimal ACTIVE reservation", () => {
    const parsed = reservationDetailFromWire({
      reservation_id: "r-2",
      status: "ACTIVE",
      subject: { tenant: "acme" },
      action: { kind: "tool.search", name: "web.search" },
      reserved: { unit: "TOKENS", amount: 500 },
      created_at_ms: 1700000000000,
      expires_at_ms: 1700000060000,
      scope_path: "/acme",
      affected_scopes: ["tenant:acme"],
    });
    expect(parsed.reservationId).toBe("r-2");
    expect(parsed.idempotencyKey).toBeUndefined();
    expect(parsed.committed).toBeUndefined();
    expect(parsed.finalizedAtMs).toBeUndefined();
    expect(parsed.metadata).toBeUndefined();
  });
});

describe("reservationSummaryFromWire", () => {
  it("converts wire reservation summary", () => {
    const parsed = reservationSummaryFromWire({
      reservation_id: "r-1",
      status: "ACTIVE",
      subject: { tenant: "acme" },
      action: { kind: "llm.completion", name: "openai:gpt-4o" },
      reserved: { unit: "USD_MICROCENTS", amount: 1000 },
      created_at_ms: 1700000000000,
      expires_at_ms: 1700000060000,
      scope_path: "/acme",
      affected_scopes: ["tenant:acme"],
      idempotency_key: "key-1",
    });
    expect(parsed.reservationId).toBe("r-1");
    expect(parsed.status).toBe("ACTIVE");
    expect(parsed.subject).toEqual({ tenant: "acme" });
    expect(parsed.action).toEqual({ kind: "llm.completion", name: "openai:gpt-4o" });
    expect(parsed.idempotencyKey).toBe("key-1");
  });
});

describe("reservationListResponseFromWire", () => {
  it("converts wire list response with pagination", () => {
    const parsed = reservationListResponseFromWire({
      reservations: [
        {
          reservation_id: "r-1",
          status: "ACTIVE",
          subject: { tenant: "acme" },
          action: { kind: "llm.completion", name: "gpt-4o" },
          reserved: { unit: "USD_MICROCENTS", amount: 1000 },
          created_at_ms: 1700000000000,
          expires_at_ms: 1700000060000,
          scope_path: "/acme",
          affected_scopes: ["tenant:acme"],
        },
      ],
      next_cursor: "cursor-abc",
      has_more: true,
    });
    expect(parsed.reservations).toHaveLength(1);
    expect(parsed.reservations[0].reservationId).toBe("r-1");
    expect(parsed.nextCursor).toBe("cursor-abc");
    expect(parsed.hasMore).toBe(true);
  });

  it("handles empty list", () => {
    const parsed = reservationListResponseFromWire({
      reservations: [],
      has_more: false,
    });
    expect(parsed.reservations).toEqual([]);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextCursor).toBeUndefined();
  });
});

describe("balanceResponseFromWire", () => {
  it("converts wire balance response with full balance fields", () => {
    const parsed = balanceResponseFromWire({
      balances: [
        {
          scope: "tenant:acme",
          scope_path: "/acme",
          remaining: { unit: "USD_MICROCENTS", amount: 5000 },
          reserved: { unit: "USD_MICROCENTS", amount: 1000 },
          spent: { unit: "USD_MICROCENTS", amount: 3000 },
          allocated: { unit: "USD_MICROCENTS", amount: 10000 },
          debt: { unit: "USD_MICROCENTS", amount: 500 },
          overdraft_limit: { unit: "USD_MICROCENTS", amount: 2000 },
          is_over_limit: false,
        },
      ],
      next_cursor: "cursor-xyz",
      has_more: true,
    });
    expect(parsed.balances).toHaveLength(1);
    const b = parsed.balances[0];
    expect(b.scope).toBe("tenant:acme");
    expect(b.scopePath).toBe("/acme");
    expect(b.remaining).toEqual({ unit: "USD_MICROCENTS", amount: 5000 });
    expect(b.reserved).toEqual({ unit: "USD_MICROCENTS", amount: 1000 });
    expect(b.spent).toEqual({ unit: "USD_MICROCENTS", amount: 3000 });
    expect(b.allocated).toEqual({ unit: "USD_MICROCENTS", amount: 10000 });
    expect(b.debt).toEqual({ unit: "USD_MICROCENTS", amount: 500 });
    expect(b.overdraftLimit).toEqual({ unit: "USD_MICROCENTS", amount: 2000 });
    expect(b.isOverLimit).toBe(false);
    expect(parsed.nextCursor).toBe("cursor-xyz");
    expect(parsed.hasMore).toBe(true);
  });

  it("handles empty balances", () => {
    const parsed = balanceResponseFromWire({ balances: [] });
    expect(parsed.balances).toEqual([]);
    expect(parsed.hasMore).toBeUndefined();
    expect(parsed.nextCursor).toBeUndefined();
  });
});

// --- Request-to-wire mappers ---

describe("reservationCreateRequestToWire", () => {
  it("converts full request to wire format", () => {
    const wire = reservationCreateRequestToWire({
      idempotencyKey: "key-1",
      subject: { tenant: "acme", app: "myapp" },
      action: { kind: "llm.completion", name: "openai:gpt-4o", tags: ["prod"] },
      estimate: { unit: "USD_MICROCENTS", amount: 1000 },
      ttlMs: 30000,
      gracePeriodMs: 10000,
      overagePolicy: "ALLOW_IF_AVAILABLE",
      dryRun: true,
      metadata: { run_id: "run-1" },
    });
    expect(wire.idempotency_key).toBe("key-1");
    expect(wire.subject).toEqual({ tenant: "acme", app: "myapp" });
    expect(wire.action).toEqual({ kind: "llm.completion", name: "openai:gpt-4o", tags: ["prod"] });
    expect(wire.estimate).toEqual({ unit: "USD_MICROCENTS", amount: 1000 });
    expect(wire.ttl_ms).toBe(30000);
    expect(wire.grace_period_ms).toBe(10000);
    expect(wire.overage_policy).toBe("ALLOW_IF_AVAILABLE");
    expect(wire.dry_run).toBe(true);
    expect(wire.metadata).toEqual({ run_id: "run-1" });
  });

  it("strips undefined optional fields", () => {
    const wire = reservationCreateRequestToWire({
      idempotencyKey: "key-2",
      subject: { tenant: "acme" },
      action: { kind: "llm.completion", name: "gpt-4o" },
      estimate: { unit: "TOKENS", amount: 500 },
    });
    expect(wire.idempotency_key).toBe("key-2");
    expect("ttl_ms" in wire).toBe(false);
    expect("grace_period_ms" in wire).toBe(false);
    expect("overage_policy" in wire).toBe(false);
    expect("dry_run" in wire).toBe(false);
    expect("metadata" in wire).toBe(false);
  });

  it("strips undefined subject fields", () => {
    const wire = reservationCreateRequestToWire({
      idempotencyKey: "key-3",
      subject: { tenant: "acme", dimensions: { env: "prod" } },
      action: { kind: "tool.search", name: "web.search" },
      estimate: { unit: "USD_MICROCENTS", amount: 100 },
    });
    const subject = wire.subject as Record<string, unknown>;
    expect(subject.tenant).toBe("acme");
    expect(subject.dimensions).toEqual({ env: "prod" });
    expect("workspace" in subject).toBe(false);
    expect("app" in subject).toBe(false);
  });
});

describe("commitRequestToWire", () => {
  it("converts full request with metrics", () => {
    const wire = commitRequestToWire({
      idempotencyKey: "key-1",
      actual: { unit: "USD_MICROCENTS", amount: 800 },
      metrics: { tokensInput: 100, tokensOutput: 200, latencyMs: 500 },
      metadata: { model: "gpt-4o" },
    });
    expect(wire.idempotency_key).toBe("key-1");
    expect(wire.actual).toEqual({ unit: "USD_MICROCENTS", amount: 800 });
    expect(wire.metrics).toEqual({
      tokens_input: 100,
      tokens_output: 200,
      latency_ms: 500,
    });
    expect(wire.metadata).toEqual({ model: "gpt-4o" });
  });

  it("strips metrics when not provided", () => {
    const wire = commitRequestToWire({
      idempotencyKey: "key-2",
      actual: { unit: "TOKENS", amount: 50 },
    });
    expect("metrics" in wire).toBe(false);
    expect("metadata" in wire).toBe(false);
  });
});

describe("releaseRequestToWire", () => {
  it("converts with reason", () => {
    const wire = releaseRequestToWire({
      idempotencyKey: "key-1",
      reason: "user_cancelled",
    });
    expect(wire.idempotency_key).toBe("key-1");
    expect(wire.reason).toBe("user_cancelled");
  });

  it("strips undefined reason", () => {
    const wire = releaseRequestToWire({ idempotencyKey: "key-2" });
    expect(wire.idempotency_key).toBe("key-2");
    expect("reason" in wire).toBe(false);
  });
});

describe("reservationExtendRequestToWire", () => {
  it("converts full request", () => {
    const wire = reservationExtendRequestToWire({
      idempotencyKey: "key-1",
      extendByMs: 30000,
      metadata: { reason: "long_running" },
    });
    expect(wire.idempotency_key).toBe("key-1");
    expect(wire.extend_by_ms).toBe(30000);
    expect(wire.metadata).toEqual({ reason: "long_running" });
  });

  it("strips undefined metadata", () => {
    const wire = reservationExtendRequestToWire({
      idempotencyKey: "key-2",
      extendByMs: 60000,
    });
    expect("metadata" in wire).toBe(false);
  });
});

describe("decisionRequestToWire", () => {
  it("converts full request", () => {
    const wire = decisionRequestToWire({
      idempotencyKey: "key-1",
      subject: { tenant: "acme", workspace: "ws1" },
      action: { kind: "llm.completion", name: "gpt-4o", tags: ["staging"] },
      estimate: { unit: "USD_MICROCENTS", amount: 500 },
      metadata: { source: "agent" },
    });
    expect(wire.idempotency_key).toBe("key-1");
    expect(wire.subject).toEqual({ tenant: "acme", workspace: "ws1" });
    expect(wire.action).toEqual({ kind: "llm.completion", name: "gpt-4o", tags: ["staging"] });
    expect(wire.estimate).toEqual({ unit: "USD_MICROCENTS", amount: 500 });
    expect(wire.metadata).toEqual({ source: "agent" });
  });

  it("strips undefined metadata", () => {
    const wire = decisionRequestToWire({
      idempotencyKey: "key-2",
      subject: { tenant: "acme" },
      action: { kind: "tool.search", name: "web.search" },
      estimate: { unit: "TOKENS", amount: 100 },
    });
    expect("metadata" in wire).toBe(false);
  });
});

describe("eventCreateRequestToWire", () => {
  it("converts full request with all optional fields", () => {
    const wire = eventCreateRequestToWire({
      idempotencyKey: "key-1",
      subject: { tenant: "acme", agent: "bot1" },
      action: { kind: "llm.completion", name: "gpt-4o" },
      actual: { unit: "USD_MICROCENTS", amount: 1200 },
      overagePolicy: "ALLOW_WITH_OVERDRAFT",
      metrics: { tokensInput: 50, tokensOutput: 100 },
      clientTimeMs: 1700000000000,
      metadata: { trace_id: "t-1" },
    });
    expect(wire.idempotency_key).toBe("key-1");
    expect(wire.subject).toEqual({ tenant: "acme", agent: "bot1" });
    expect(wire.action).toEqual({ kind: "llm.completion", name: "gpt-4o" });
    expect(wire.actual).toEqual({ unit: "USD_MICROCENTS", amount: 1200 });
    expect(wire.overage_policy).toBe("ALLOW_WITH_OVERDRAFT");
    expect(wire.metrics).toEqual({ tokens_input: 50, tokens_output: 100 });
    expect(wire.client_time_ms).toBe(1700000000000);
    expect(wire.metadata).toEqual({ trace_id: "t-1" });
  });

  it("strips undefined optional fields", () => {
    const wire = eventCreateRequestToWire({
      idempotencyKey: "key-2",
      subject: { tenant: "acme" },
      action: { kind: "tool.search", name: "web.search" },
      actual: { unit: "TOKENS", amount: 50 },
    });
    expect("overage_policy" in wire).toBe(false);
    expect("metrics" in wire).toBe(false);
    expect("client_time_ms" in wire).toBe(false);
    expect("metadata" in wire).toBe(false);
  });
});
