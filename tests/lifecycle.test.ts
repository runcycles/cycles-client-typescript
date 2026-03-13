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
});
