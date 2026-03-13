import { describe, it, expect, vi, afterEach } from "vitest";
import { AsyncCyclesLifecycle } from "../src/lifecycle.js";
import { CyclesResponse } from "../src/response.js";
import { CommitRetryEngine } from "../src/retry.js";
import { CyclesConfig } from "../src/config.js";
import { getCyclesContext } from "../src/context.js";
import { BudgetExceededError, CyclesProtocolError } from "../src/exceptions.js";

function makeConfig() {
  return new CyclesConfig({ baseUrl: "http://localhost", apiKey: "key" });
}

function makeRetryEngine(config?: CyclesConfig) {
  return new CommitRetryEngine(config ?? makeConfig());
}

function makeMockClient() {
  return {
    config: makeConfig(),
    createReservation: vi.fn(),
    commitReservation: vi.fn(),
    releaseReservation: vi.fn(),
    extendReservation: vi.fn(),
  };
}

describe("AsyncCyclesLifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes reserve -> execute -> commit flow", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: ["tenant:acme"],
        expires_at_ms: Date.now() + 60000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const fn = vi.fn().mockResolvedValue("result");
    const result = await lifecycle.execute(fn, [], {
      estimate: 1000,
      actionKind: "llm.completion",
      actionName: "gpt-4",
    });

    expect(result).toBe("result");
    expect(fn).toHaveBeenCalledOnce();
    expect(client.createReservation).toHaveBeenCalledOnce();
    expect(client.commitReservation).toHaveBeenCalledOnce();

    // Verify wire-format keys in reservation body
    const createBody = client.createReservation.mock.calls[0][0];
    expect(createBody.idempotency_key).toBeDefined();
    expect(createBody.ttl_ms).toBe(60000);
    expect(createBody.overage_policy).toBe("REJECT");

    // Verify wire-format keys in commit body
    const commitBody = client.commitReservation.mock.calls[0][1];
    expect(commitBody.idempotency_key).toBeDefined();
    expect(commitBody.actual).toEqual({ unit: "USD_MICROCENTS", amount: 1000 });
  });

  it("provides context inside guarded function", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-ctx",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    let capturedCtx: any = null;
    await lifecycle.execute(
      async () => {
        capturedCtx = getCyclesContext();
        return "ok";
      },
      [],
      { estimate: 500 },
    );

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx.reservationId).toBe("r-ctx");
    expect(capturedCtx.estimate).toBe(500);
    expect(capturedCtx.decision).toBe("ALLOW");
  });

  it("throws on DENY", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "DENY",
        affected_scopes: [],
        reason_code: "BUDGET_EXCEEDED",
      }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await expect(
      lifecycle.execute(async () => "never", [], { estimate: 1000 }),
    ).rejects.toThrow("Reservation denied");
  });

  it("throws BudgetExceededError on BUDGET_EXCEEDED", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.httpError(402, "Budget exceeded", {
        error: "BUDGET_EXCEEDED",
        message: "Insufficient budget",
        request_id: "req-1",
      }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await expect(
      lifecycle.execute(async () => "never", [], { estimate: 1000 }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("releases reservation on function error", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-fail",
        affected_scopes: [],
      }),
    );
    client.releaseReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "RELEASED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await expect(
      lifecycle.execute(
        async () => {
          throw new Error("boom");
        },
        [],
        { estimate: 1000 },
      ),
    ).rejects.toThrow("boom");

    expect(client.releaseReservation).toHaveBeenCalledOnce();
    const releaseArgs = client.releaseReservation.mock.calls[0];
    expect(releaseArgs[0]).toBe("r-fail");
  });

  it("returns DryRunResult for dry run", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        affected_scopes: ["tenant:acme"],
        scope_path: "/acme",
        reserved: { unit: "USD_MICROCENTS", amount: 1000 },
      }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => "should not run",
      [],
      { estimate: 1000, dryRun: true },
    );

    expect(result).toEqual(
      expect.objectContaining({
        decision: "ALLOW",
        affectedScopes: ["tenant:acme"],
      }),
    );
    // Function should not have been called in dry-run
    expect(client.commitReservation).not.toHaveBeenCalled();
  });

  it("uses callable estimate", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await lifecycle.execute(async (x: number) => x * 2, [42], {
      estimate: (x: number) => x * 10,
    });

    const createBody = client.createReservation.mock.calls[0][0];
    expect(createBody.estimate.amount).toBe(420);
  });

  it("schedules retry on commit failure", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(500, "Server error"),
    );

    const retryEngine = makeRetryEngine();
    const scheduleSpy = vi.spyOn(retryEngine, "schedule");

    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });
    await lifecycle.execute(async () => "ok", [], { estimate: 1000 });

    expect(scheduleSpy).toHaveBeenCalledOnce();
  });

  it("throws on reservation create failure", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.transportError(new Error("ECONNREFUSED")),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await expect(
      lifecycle.execute(async () => "never", [], { estimate: 1000 }),
    ).rejects.toBeInstanceOf(CyclesProtocolError);
  });

  // --- _handleCommit error-code branch tests ---

  it("silently succeeds on RESERVATION_FINALIZED commit error", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(409, "Finalized", {
        error: "RESERVATION_FINALIZED",
        message: "Already finalized",
        request_id: "req-1",
      }),
    );

    const retryEngine = makeRetryEngine();
    const scheduleSpy = vi.spyOn(retryEngine, "schedule");
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(async () => "ok", [], { estimate: 1000 });
    expect(result).toBe("ok");
    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(client.releaseReservation).not.toHaveBeenCalled();
  });

  it("silently succeeds on RESERVATION_EXPIRED commit error", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(409, "Expired", {
        error: "RESERVATION_EXPIRED",
        message: "Reservation expired",
        request_id: "req-1",
      }),
    );

    const retryEngine = makeRetryEngine();
    const scheduleSpy = vi.spyOn(retryEngine, "schedule");
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(async () => "ok", [], { estimate: 1000 });
    expect(result).toBe("ok");
    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(client.releaseReservation).not.toHaveBeenCalled();
  });

  it("silently succeeds on IDEMPOTENCY_MISMATCH commit error", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(409, "Idempotency mismatch", {
        error: "IDEMPOTENCY_MISMATCH",
        message: "Key mismatch",
        request_id: "req-1",
      }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(async () => "ok", [], { estimate: 1000 });
    expect(result).toBe("ok");
  });

  it("releases reservation on other client commit errors", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(400, "Bad request", {
        error: "INVALID_REQUEST",
        message: "Bad commit body",
        request_id: "req-1",
      }),
    );
    client.releaseReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "RELEASED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(async () => "ok", [], { estimate: 1000 });
    expect(result).toBe("ok");
    expect(client.releaseReservation).toHaveBeenCalledOnce();
    const releaseArgs = client.releaseReservation.mock.calls[0];
    expect(releaseArgs[0]).toBe("r-1");
  });

  it("schedules retry when commit throws an exception", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockRejectedValue(new Error("network error"));

    const retryEngine = makeRetryEngine();
    const scheduleSpy = vi.spyOn(retryEngine, "schedule");
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(async () => "ok", [], { estimate: 1000 });
    expect(result).toBe("ok");
    expect(scheduleSpy).toHaveBeenCalledOnce();
  });

  // --- Heartbeat tests ---

  it("heartbeat extends reservation periodically", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb",
        affected_scopes: [],
        expires_at_ms: Date.now() + 60000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    client.extendReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: Date.now() + 120000 }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    // Use a long-running function so heartbeat fires
    const fnPromise = lifecycle.execute(
      async () => {
        // Advance past the heartbeat interval (ttlMs/2 = 30000ms)
        await vi.advanceTimersByTimeAsync(31000);
        return "done";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );

    const result = await fnPromise;
    expect(result).toBe("done");
    expect(client.extendReservation).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("heartbeat swallows extend failures", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-fail",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    client.extendReservation.mockRejectedValue(new Error("extend failed"));

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        await vi.advanceTimersByTimeAsync(31000);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );

    expect(result).toBe("ok");
    expect(client.extendReservation).toHaveBeenCalled();

    vi.useRealTimers();
  });

  // --- evaluateActual tests ---

  it("uses callable actual function to compute actual amount", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await lifecycle.execute(async () => 42, [], {
      estimate: 1000,
      actual: (result: number) => result * 100,
    });

    const commitBody = client.commitReservation.mock.calls[0][1];
    expect(commitBody.actual.amount).toBe(4200);
  });

  it("uses static actual number", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await lifecycle.execute(async () => "result", [], {
      estimate: 1000,
      actual: 777,
    });

    const commitBody = client.commitReservation.mock.calls[0][1];
    expect(commitBody.actual.amount).toBe(777);
  });

  it("throws when actual is undefined and useEstimateIfActualNotProvided is false", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: [],
      }),
    );
    client.releaseReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "RELEASED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await expect(
      lifecycle.execute(async () => "result", [], {
        estimate: 1000,
        useEstimateIfActualNotProvided: false,
      }),
    ).rejects.toThrow("actual expression is required");
  });

  // --- Context metrics and metadata tests ---

  it("commit includes context metrics and metadata set inside guarded function", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-metrics",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await lifecycle.execute(
      async () => {
        const ctx = getCyclesContext()!;
        ctx.metrics = { tokensInput: 100, tokensOutput: 200 };
        ctx.commitMetadata = { model: "gpt-4o" };
        return "done";
      },
      [],
      { estimate: 1000 },
    );

    const commitBody = client.commitReservation.mock.calls[0][1];
    expect(commitBody.metrics).toEqual(
      expect.objectContaining({
        tokens_input: 100,
        tokens_output: 200,
      }),
    );
    expect(commitBody.metadata).toEqual({ model: "gpt-4o" });
  });

  it("auto-sets latencyMs when not provided in metrics", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-latency",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await lifecycle.execute(async () => "ok", [], { estimate: 1000 });

    const commitBody = client.commitReservation.mock.calls[0][1];
    expect(commitBody.metrics.latency_ms).toBeTypeOf("number");
    expect(commitBody.metrics.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("does not override latencyMs if already set", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-latency2",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await lifecycle.execute(
      async () => {
        const ctx = getCyclesContext()!;
        ctx.metrics = { latencyMs: 999 };
        return "ok";
      },
      [],
      { estimate: 1000 },
    );

    const commitBody = client.commitReservation.mock.calls[0][1];
    expect(commitBody.metrics.latency_ms).toBe(999);
  });

  it("throws when missing reservation_id in non-DENY response", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        // No reservation_id!
        affected_scopes: [],
      }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await expect(
      lifecycle.execute(async () => "never", [], { estimate: 1000 }),
    ).rejects.toThrow("reservation_id missing");
  });

  it("dry-run DENY throws protocol exception", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "DENY",
        affected_scopes: [],
        reason_code: "BUDGET_EXCEEDED",
      }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await expect(
      lifecycle.execute(async () => "never", [], { estimate: 1000, dryRun: true }),
    ).rejects.toThrow("Dry-run denied");
  });

  // --- Bug fix regression: malformed 4xx body fallback ---

  it("extracts error code from raw body when getErrorResponse returns undefined", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: [],
      }),
    );
    // 409 with error code but missing request_id — getErrorResponse() returns undefined
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(409, "Finalized", {
        error: "RESERVATION_FINALIZED",
        message: "Already finalized",
        // No request_id — errorResponseFromWire returns undefined
      }),
    );

    const retryEngine = makeRetryEngine();
    const scheduleSpy = vi.spyOn(retryEngine, "schedule");
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(async () => "ok", [], { estimate: 1000 });
    expect(result).toBe("ok");
    // Should still detect RESERVATION_FINALIZED via raw body fallback
    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(client.releaseReservation).not.toHaveBeenCalled();
  });

  it("uses 'unknown' in release reason when error code is truly missing", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: [],
      }),
    );
    // 400 with no error code at all in body
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(400, "Bad request", {
        message: "Malformed body",
      }),
    );
    client.releaseReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "RELEASED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await lifecycle.execute(async () => "ok", [], { estimate: 1000 });

    expect(client.releaseReservation).toHaveBeenCalledOnce();
    const releaseBody = client.releaseReservation.mock.calls[0][1];
    expect(releaseBody.reason).toBe("commit_rejected_unknown");
  });

  it("uses gracePeriodMs and dimensions in request body", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-gp",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await lifecycle.execute(async () => "ok", [], {
      estimate: 1000,
      gracePeriodMs: 5000,
      dimensions: { env: "prod" },
    });

    const createBody = client.createReservation.mock.calls[0][0];
    expect(createBody.grace_period_ms).toBe(5000);
    expect(createBody.subject.dimensions).toEqual({ env: "prod" });
  });
});
