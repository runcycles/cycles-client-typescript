import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AsyncCyclesLifecycle,
  createLeadFloorAtScheduleStart,
  createReservationWithRecovery,
  isSchemaValidCreateResponse,
  isSchemaValidExtendResponse,
} from "../src/lifecycle.js";
import { CyclesResponse } from "../src/response.js";
import { CommitRetryEngine } from "../src/retry.js";
import { CyclesConfig } from "../src/config.js";
import { getCyclesContext } from "../src/context.js";
import { BudgetExceededError, CyclesProtocolError, TenantClosedError } from "../src/exceptions.js";

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
    // Default: a schema-valid applied extend. The first fallback beat is
    // immediate, so tests that exercise heartbeat behavior override it.
    extendReservation: vi
      .fn()
      .mockResolvedValue(
        CyclesResponse.success(200, {
          status: "ACTIVE",
          expires_at_ms: 1_000_060_000,
        }),
      ),
  };
}

const validCreateBody = {
  decision: "ALLOW",
  reservation_id: "r-strict",
  affected_scopes: ["tenant:acme"],
  expires_at_ms: 1_000_000,
  remaining_ttl_ms: 60_000,
};

describe("strict lease response contract", () => {
  it("deducts local setup time after create response receipt", () => {
    expect(createLeadFloorAtScheduleStart(60_000, 500, 1_000, 3_000)).toBe(
      57_500,
    );
    expect(createLeadFloorAtScheduleStart(60_000, 500, 3_000, 1_000)).toBe(
      undefined,
    );
  });

  it("recovers one ambiguous create immediately with the same body and key", async () => {
    const client = makeMockClient();
    const request = { idempotency_key: "same-key" };
    client.createReservation
      .mockResolvedValueOnce(CyclesResponse.success(202, validCreateBody))
      .mockResolvedValueOnce(CyclesResponse.success(200, validCreateBody));

    const result = await createReservationWithRecovery(client as any, request);

    expect(result.response.status).toBe(200);
    expect(result.result.reservationId).toBe("r-strict");
    expect(result.rttMs).toBeGreaterThanOrEqual(0);
    expect(client.createReservation).toHaveBeenCalledTimes(2);
    expect(client.createReservation.mock.calls[0][0]).toBe(request);
    expect(client.createReservation.mock.calls[1][0]).toBe(request);
  });

  it("surfaces a schema-invalid 200 after the single recovery", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        ...validCreateBody,
        balances: [{ scope: "tenant:acme" }],
      }),
    );

    await expect(
      createReservationWithRecovery(client as any, {
        idempotency_key: "same-key",
      }),
    ).rejects.toThrow("schema-valid HTTP 200");
    expect(client.createReservation).toHaveBeenCalledTimes(2);
  });

  it("validates the complete create schema including nested evidence", () => {
    expect(
      isSchemaValidCreateResponse(
        CyclesResponse.success(200, {
          ...validCreateBody,
          cycles_evidence: {
            evidence_id: "a".repeat(64),
            cycles_evidence_url: "https://cycles.example/v1/evidence/id",
          },
          balances: [
            {
              scope: "tenant:acme",
              scope_path: "tenant:acme",
              remaining: { unit: "USD_MICROCENTS", amount: -1 },
              reserved: { unit: "USD_MICROCENTS", amount: 1 },
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      isSchemaValidCreateResponse(
        CyclesResponse.success(200, {
          ...validCreateBody,
          cycles_evidence: {
            evidence_id: "not-a-hash",
            cycles_evidence_url: "relative",
          },
        }),
      ),
    ).toBe(false);
    expect(
      isSchemaValidCreateResponse(
        CyclesResponse.success(200, {
          ...validCreateBody,
          caps: null,
        }),
      ),
    ).toBe(false);
    expect(
      isSchemaValidCreateResponse(
        CyclesResponse.success(200, {
          ...validCreateBody,
          remaining_ttl_ms: Number.MAX_SAFE_INTEGER + 1,
        }),
      ),
    ).toBe(false);
    expect(
      isSchemaValidCreateResponse(
        CyclesResponse.success(200, {
          ...validCreateBody,
          expires_at_ms: -1,
        }),
      ),
    ).toBe(false);
  });

  it.each([
    CyclesResponse.success(202, {
      status: "ACTIVE",
      expires_at_ms: 1,
    }),
    CyclesResponse.success(200, { status: "ACTIVE" }),
    CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: -1 }),
    CyclesResponse.success(200, {
      status: "ACTIVE",
      expires_at_ms: 1,
      extra: true,
    }),
    CyclesResponse.success(200, {
      status: "ACTIVE",
      expires_at_ms: 1,
      balances: [{ scope: "tenant:acme" }],
    }),
    CyclesResponse.success(200, {
      status: "ACTIVE",
      expires_at_ms: Number.MAX_SAFE_INTEGER + 1,
    }),
    CyclesResponse.success(200, {
      status: "ACTIVE",
      expires_at_ms: 1,
      balances: [
        {
          scope: "tenant:acme",
          scope_path: "tenant:acme",
          remaining: { unit: "TOKENS", amount: 1 },
          debt: null,
        },
      ],
    }),
  ])("rejects a non-schema extend response", (response) => {
    expect(isSchemaValidExtendResponse(response)).toBe(false);
  });
});

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
    expect(createBody.overage_policy).toBe("ALLOW_IF_AVAILABLE");

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

  it("throws TenantClosedError on TENANT_CLOSED", async () => {
    // Runtime spec v0.1.25.13: HTTP 409 TENANT_CLOSED on reservation
    // create when the owning tenant is CLOSED.
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.httpError(409, "Tenant closed", {
        error: "TENANT_CLOSED",
        message: "Owning tenant is CLOSED",
        request_id: "req-tc",
      }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await expect(
      lifecycle.execute(async () => "never", [], { estimate: 1000 }),
    ).rejects.toBeInstanceOf(TenantClosedError);
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

    await lifecycle.execute(async (x) => (x as number) * 2, [42], {
      estimate: (x) => (x as number) * 10,
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

  it("does not release known spend on recognized client commit errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(async () => "ok", [], { estimate: 1000 });
    expect(result).toBe("ok");
    expect(client.releaseReservation).not.toHaveBeenCalled();
    errorSpy.mockRestore();
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

  it("heartbeat logs thrown transport failures and keeps the action alive", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    client.extendReservation
      .mockRejectedValueOnce(new Error("extend failed"))
      .mockResolvedValueOnce(
        CyclesResponse.success(200, {
          status: "ACTIVE",
          expires_at_ms: 1_000_000_000,
        }),
      );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        await vi.advanceTimersByTimeAsync(61000);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );

    expect(result).toBe("ok");
    expect(client.extendReservation.mock.calls.length).toBeGreaterThanOrEqual(2);
    const firstTwoKeys = client.extendReservation.mock.calls
      .slice(0, 2)
      .map((call) => (call[1] as Record<string, unknown>).idempotency_key);
    expect(firstTwoKeys[0]).toBe(firstTwoKeys[1]);
    expect(client.commitReservation).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Heartbeat extend transport error; retrying next beat with the same key",
      ),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("r-hb-fail"));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error: extend failed"),
    );

    vi.useRealTimers();
  });

  it("heartbeat reports when a field-mode transport failure exhausts the safe recovery window", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-field-transport-stop",
        affected_scopes: [],
        expires_at_ms: 1_000_000_000,
        remaining_ttl_ms: 1000,
      }),
    );
    client.extendReservation.mockRejectedValue(new Error("socket closed"));
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const lifecycle = new AsyncCyclesLifecycle(
      client as any,
      makeRetryEngine(),
      { tenant: "acme" },
    );
    const result = await lifecycle.execute(
      async () => {
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60_000 },
    );

    expect(result).toBe("ok");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Heartbeat extend transport error; recovery stopped: r-hb-field-transport-stop",
      ),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error: socket closed"),
    );
    vi.useRealTimers();
  });

  it("heartbeat leadMin: immediate first beat, extends beats 1-3, skips beat 4, extends beat 5, skips beat 6", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    const e0 = 1_000_000_000; // server-frame initial expiry
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-lead",
        affected_scopes: [],
        expires_at_ms: e0,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    // Each applied extend grants the full ttl relative to current expiry.
    let expiry = e0;
    client.extendReservation.mockImplementation(async () => {
      expiry += 60000;
      return CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: expiry });
    });

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // leadMin = grantsSum - elapsed starts at 0 (the initial grant is
        // never counted); each measured grant adds 60000, each 30s of
        // elapsed subtracts 30000.
        // Beat 1 fires IMMEDIATELY (delay 0): lastGrant undefined -> extend
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // Beat 2 at 30s: leadMin 60000-30000=30000 < 90000 -> extend
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        // Beat 3 at 60s: leadMin 120000-60000=60000 < 90000 -> extend
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        // Beat 4 at 90s: leadMin 180000-90000=90000 >= 1.5*60000 -> skip
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        // Beat 5 at 120s: leadMin 180000-120000=60000 < 90000 -> extend
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(4);
        // Beat 6 at 150s: leadMin 240000-150000=90000 >= 90000 -> skip
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(4);
        return "done";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("done");

    // Every extend body requests the full REQUESTED ttlMs.
    for (const call of client.extendReservation.mock.calls) {
      expect(call[1].extend_by_ms).toBe(60000);
    }
    expect(client.extendReservation.mock.calls[0][1].idempotency_key).toBeDefined();

    vi.useRealTimers();
  });

  it("heartbeat retries a failed extend with the SAME idempotency key, then regenerates after success", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-retry",
        affected_scopes: [],
        expires_at_ms: e0,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    // Beat 1 throws, beat 2 gets a retryable non-2xx, beat 3+ succeed.
    let calls = 0;
    client.extendReservation.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      if (calls === 2) return CyclesResponse.httpError(500, "Server error");
      return CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: e0 + 60000 * (calls - 2),
      });
    });

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Beat 1 (immediate): attempt fails (thrown)
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // Beat 2 at 30s: retried on the next beat, fails again (non-2xx)
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        // Beat 3 at 60s: retried, succeeds
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        // Beat 4 at 90s: only one grant measured so far (leadMin =
        // 60000 - 90000 < 0) -> extends again with a FRESH key
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(4);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");

    // Retries of an unresolved extend reuse the SAME idempotency key so a
    // lost response cannot double-extend; success regenerates.
    const keys = client.extendReservation.mock.calls.map((c: any[]) => c[1].idempotency_key);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);

    vi.useRealTimers();
  });

  it("heartbeat first-beat 503 waits the held interval before retrying (no hot loop), same key", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-first503",
        affected_scopes: [],
        expires_at_ms: e0,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    let calls = 0;
    client.extendReservation.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return CyclesResponse.httpError(503, "Service unavailable");
      return CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: e0 + 60000 });
    });

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Beat 1 (immediate, delay 0) fails transiently.
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // The retry must wait the HELD interval min(ttl/2, 30s) = 30s —
        // the 0 delay applies to the first schedule only; a 0-delay
        // reschedule would hot-loop against a down server.
        await vi.advanceTimersByTimeAsync(29_999);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");

    // The retry reuses the SAME idempotency key as the unresolved attempt.
    const keys = client.extendReservation.mock.calls.map((c: any[]) => c[1].idempotency_key);
    expect(keys[1]).toBe(keys[0]);
    warnSpy.mockRestore();

    vi.useRealTimers();
  });

  it("heartbeat stops permanently on MAX_EXTENSIONS_EXCEEDED", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-max",
        affected_scopes: [],
        expires_at_ms: 1_000_000_000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    client.extendReservation.mockResolvedValue(
      CyclesResponse.httpError(409, "Max extensions exceeded", {
        error: "MAX_EXTENSIONS_EXCEEDED",
      }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Beat 1 (immediate): extend rejected permanently -> heartbeat stops
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // Subsequent beats: no further extend attempts
        await vi.advanceTimersByTimeAsync(120000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("permanently rejected"),
    );

    vi.useRealTimers();
  });

  it("heartbeat stays live for small ttl (1200ms): interval is ttl/2 with no 1s floor", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-small",
        affected_scopes: [],
        expires_at_ms: e0,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    let expiry = e0;
    client.extendReservation.mockImplementation(async () => {
      expiry += 1200;
      return CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: expiry });
    });

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // First beat is IMMEDIATE — a small (possibly capped) lease can
        // outlive any bounded first-beat delay, so beat 1 primes at t=0.
        // Measured grants of 1200 then keep the cadence at
        // clamp(1200/2, 500, min(600, 30s)) = 600ms — no 1s floor (a 1s
        // interval would add only 1.2s of expiry per 2s of wall time and
        // guarantee a lapse).
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // Beats 2-3 extend (leadMin 1200-600=600, 2400-1200=1200 < 1800).
        await vi.advanceTimersByTimeAsync(600);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(600);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        // Beat 4 at 1800ms: leadMin 3600-1800=1800 >= 1.5*1200 -> skip.
        await vi.advanceTimersByTimeAsync(600);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        // Beat 5 at 2400ms: leadMin 3600-2400=1200 < 1800 -> extend.
        await vi.advanceTimersByTimeAsync(600);
        expect(client.extendReservation).toHaveBeenCalledTimes(4);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 1200 },
    );
    expect(result).toBe("ok");

    vi.useRealTimers();
  });

  it("heartbeat tightens cadence to the MEASURED grant when the server clamps", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-clamp",
        affected_scopes: [],
        expires_at_ms: e0,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    // Server clamps every grant to ttl/4 instead of the requested ttl.
    let expiry = e0;
    client.extendReservation.mockImplementation(async () => {
      expiry += 15000;
      return CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: expiry });
    });

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Beat 1 (immediate) measures a 15000 grant. This is a GRANT
        // clamp, not a lead clamp — the grant is a real per-extend amount
        // far exceeding 1.25x the elapsed time — so the cadence tightens
        // to clamp(15000/2, 500, 30000) = 7500ms (ttl/8), derived from
        // the MEASURED grant, not the requested ttl.
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(7500);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(7500);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        // extend_by_ms still requests the full ttl every time.
        for (const call of client.extendReservation.mock.calls) {
          expect(call[1].extend_by_ms).toBe(60000);
        }
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");

    vi.useRealTimers();
  });

  it("heartbeat grant-clamp after a skip: holds once across the doubled gap, then re-tightens (no sticky lead-clamp)", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-postskip",
        affected_scopes: [],
        expires_at_ms: e0,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    // Genuine GRANT clamp: every extend grants exactly ttl/4 = 15000.
    let expiry = e0;
    client.extendReservation.mockImplementation(async () => {
      expiry += 15000;
      return CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: expiry });
    });

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Beats 1-3 extend at the grant-derived 7.5s cadence:
        //   b1@0     grant 15000, elapsed 0     -> normal, interval 7500
        //   b2@7500  leadMin 7500  < 22500 -> extend (elapsed 7500, band
        //            5625-9375 misses 15000 -> normal)
        //   b3@15000 leadMin 15000 < 22500 -> extend
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(7500);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(7500);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        // Beat 4 at 22500: leadMin 45000-22500=22500 >= 1.5*15000 -> skip.
        await vi.advanceTimersByTimeAsync(7500);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        // Beat 5 at 30000 extends ACROSS THE DOUBLED GAP: elapsed since
        // the last applied extend (b3@15000) is 15000 = grant, ratio 1 —
        // inside the 0.75x-1.25x band -> lands in the hold ONCE (interval
        // becomes the held 30s; the once-per-heartbeat clamp warn fires).
        await vi.advanceTimersByTimeAsync(7500);
        expect(client.extendReservation).toHaveBeenCalledTimes(4);
        // The hold must NOT self-sustain: nothing fires before the held
        // 30s wait elapses...
        await vi.advanceTimersByTimeAsync(29_999);
        expect(client.extendReservation).toHaveBeenCalledTimes(4);
        // ...then beat 6 at 60000 extends (leadMin 60000-60000=0): grant
        // 15000 vs elapsed 30000 gives ratio 0.5 — EXITS the band, so the
        // cadence re-tightens to the grant-derived 7500ms.
        await vi.advanceTimersByTimeAsync(1);
        expect(client.extendReservation).toHaveBeenCalledTimes(5);
        // Beat 7 at 67500: leadMin 75000-67500=7500 < 22500 -> extend.
        await vi.advanceTimersByTimeAsync(7500);
        expect(client.extendReservation).toHaveBeenCalledTimes(6);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");

    // The transient hold triggers the clamp warn (once per heartbeat).
    const clampWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("clamp lease lead"),
    );
    expect(clampWarns).toHaveLength(1);
    warnSpy.mockRestore();

    vi.useRealTimers();
  });

  it("heartbeat schema-invalid 2xx remains ambiguous and reuses its key", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-noexp",
        affected_scopes: [],
        expires_at_ms: 1_000_000_000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    // Missing expires_at_ms and an unknown status violate the response schema.
    client.extendReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "EXTENDED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Every ambiguous response is retried at the fallback cadence with
        // the same pending idempotency key; none is recorded as applied.
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(5);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");
    const keys = client.extendReservation.mock.calls.map(
      (call) => call[1].idempotency_key,
    );
    expect(new Set(keys).size).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ambiguous 2xx"),
    );

    vi.useRealTimers();
  });

  it("heartbeat capped grants: immediate first beat, cadence from the measured 1h grant, extend_by stays requested", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    // Requested 24h, but tenant policy max_reservation_ttl_ms caps every
    // grant at 1h. The first beat fires IMMEDIATELY — no bounded delay
    // can be proven safe against an unknowable capped lease — and primes
    // the lease with a real measured grant.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e0 = 5_000_000_000; // server-frame initial expiry
    const oneHour = 3_600_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-capped",
        affected_scopes: [],
        expires_at_ms: e0,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    let expiry = e0;
    client.extendReservation.mockImplementation(async () => {
      expiry += oneHour;
      return CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: expiry });
    });

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Beat 1 fires immediately (delay 0), NOT at requestedTtl/2 = 12h
        // and not even at 30s — a capped lease shorter than any delay
        // would already have expired.
        expect(client.extendReservation).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // Beat 1 measured a REAL 1h grant (1h >> 1.25x elapsed 0) -> the
        // cadence tightens to clamp(1h/2, 500, 12h) = 30min, derived from
        // the measured grant, not the request.
        // Beats 2-3 extend while leadMin < 1.5h:
        //   beat 2 at 30min: leadMin = 1h - 30min = 30min
        //   beat 3 at 60min: leadMin = 2h - 1h   = 1h
        await vi.advanceTimersByTimeAsync(oneHour / 2);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(oneHour / 2);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        // Beat 4 at 90min: leadMin = 3h - 1.5h = 1.5h >= 1.5*1h -> skip.
        await vi.advanceTimersByTimeAsync(oneHour / 2);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        // Beat 5 at 120min: leadMin = 3h - 2h = 1h < 1.5h -> extend.
        // (This post-skip grant matches the doubled 1h gap, so it lands
        // in the transient hold — covered in depth by the dedicated
        // post-skip regression test.)
        await vi.advanceTimersByTimeAsync(oneHour / 2);
        expect(client.extendReservation).toHaveBeenCalledTimes(4);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 86_400_000 },
    );
    expect(result).toBe("ok");

    // extend_by_ms always requests the REQUESTED ttl — the server owns
    // clamping; the client never fabricates a smaller ask from estimates.
    for (const call of client.extendReservation.mock.calls) {
      expect(call[1].extend_by_ms).toBe(86_400_000);
    }
    warnSpy.mockRestore();

    vi.useRealTimers();
  });

  it("heartbeat lead clamp: cadence holds at min(ttl/2, 30s), extends every beat, warns once", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    // Maximum-LEAD clamp: the server holds expires_at_ms ~ now + L, so
    // every extend response returns INITIAL + elapsed. Successive
    // expires_at_ms differences then measure ELAPSED time, not lease —
    // deriving the cadence from them would collapse the interval to the
    // 500ms floor and burn max_extensions in seconds.
    const e0 = 5_000_000_000;
    const t0 = Date.now();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-leadclamp",
        affected_scopes: [],
        expires_at_ms: e0,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    client.extendReservation.mockImplementation(async () =>
      CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: e0 + (Date.now() - t0),
      }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Beat 1 (immediate): grant = 0 (expiry unmoved) -> lead-clamp
        // regime: hold cadence at min(ttl/2, 30s) = 30s, warn.
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // If the cadence had collapsed to the 500ms floor, this advance
        // would fire ~60 beats. It fires exactly one, at 30s.
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        // Beat 2 measured grant = 30000 = elapsed (ratio 1, inside the
        // 0.75x-1.25x band) -> still lead-clamped: held cadence, keeps
        // extending every beat (leadMin = grantsSum - elapsed stays ~0,
        // always below 1.5x lastGrant).
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(4);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");

    // The lead-clamp warning fires exactly once per heartbeat.
    const clampWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("clamp lease lead"),
    );
    expect(clampWarns).toHaveLength(1);
    expect(String(clampWarns[0][0])).toContain("max_extensions");

    vi.useRealTimers();
  });

  it("heartbeat zero-grant immediate prime: first extend returns unchanged expiry -> held cadence", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    // The immediate first extend can land inside the same server
    // millisecond as the create (or hit an idempotent replay) and return
    // an unchanged expires_at_ms. A zero grant must NOT collapse the
    // cadence to the 500ms floor — it holds at min(ttl/2, 30s).
    const e0 = 5_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-zerogrant",
        affected_scopes: [],
        expires_at_ms: e0,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    let calls = 0;
    client.extendReservation.mockImplementation(async () => {
      calls += 1;
      // First extend: unchanged expiry (zero grant). Later extends grant
      // the full ttl.
      return CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: calls === 1 ? e0 : e0 + 60000 * (calls - 1),
      });
    });

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Beat 1 (immediate): zero grant -> held cadence, warn.
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // Next beat lands at 30s (held), not 500ms.
        await vi.advanceTimersByTimeAsync(29_999);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        // Beat 2 measured a real 60000 grant (>= 0.9x ttl) -> back to the
        // grant-derived cadence (30s here) with normal skip accounting.
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("clamp lease lead"),
    );

    vi.useRealTimers();
  });

  // --- remaining_ttl_ms (server-authoritative scheduling, spec PR #148) ---

  it("remaining_ttl_ms: exact schedule from create and every extend; heuristic skip bypassed", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-field",
        affected_scopes: [],
        expires_at_ms: e0,
        remaining_ttl_ms: 60000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    // Extends move expiry by a huge +1,000,000 per call — enough that the
    // heuristic leadMin skip would trip by beat 3 — while the server's
    // remaining_ttl_ms stays 60000. Field mode must both schedule exactly
    // from remaining_ttl_ms (expiry differences are never accumulated
    // into the schedule) and bypass the skip check.
    let expiry = e0;
    client.extendReservation.mockImplementation(async () => {
      expiry += 1_000_000;
      return CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: expiry,
        remaining_ttl_ms: 60000,
      });
    });

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Enforced per-attempt timeout T = connect 2000 + read 5000 =
        // 7000 (test default config). With rtt 0:
        //   attempt_budget = max(7000, 1000, 0) = 7000
        //   safety_margin  = max(1000, 0)       = 1000
        //   retry_reserve  = 2*7000 + 1000      = 15000
        //   first delay    = max(0, 60000 - 15000) = 45000
        // — derived from the create response, NOT an immediate prime.
        await vi.advanceTimersByTimeAsync(44_999);
        expect(client.extendReservation).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // Every subsequent delay recomputes to 45000 from that beat's
        // own response.
        await vi.advanceTimersByTimeAsync(45_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        // Beat 3 at 135s: grantsSum=2,000,000, elapsed 135,000 -> the
        // heuristic would skip (leadMin 1,865,000 >= 1.5*1,000,000), but
        // field mode bypasses the skip check and extends.
        await vi.advanceTimersByTimeAsync(45_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");

    // extend_by_ms is still always the requested ttl.
    for (const call of client.extendReservation.mock.calls) {
      expect(call[1].extend_by_ms).toBe(60000);
    }

    vi.useRealTimers();
  });

  it("remaining_ttl_ms zero-delay guard: a lease below the retry reserve gets ONE immediate fresh attempt, then stops", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    // 24h requested, tenant policy caps the lease at 1s and the server
    // says so authoritatively (remaining_ttl_ms=1000). The retry reserve
    // is 2*7000 + 1000 = 15000 > 1000, so next_delay = 0: the client MAY
    // make exactly ONE immediate fresh extension (an additive-delta
    // server could still establish positive lead). Here the extend also
    // comes back with remaining 1000 -> next_delay 0 AGAIN -> the
    // two-consecutive-zero-delay guard stops the heartbeat and surfaces
    // that the lease is shorter than the retry-safety budget — no
    // max_extensions-burning tight loop, and no silent fallback.
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-field-guard",
        affected_scopes: [],
        expires_at_ms: e0,
        remaining_ttl_ms: 1000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    let expiry = e0;
    client.extendReservation.mockImplementation(async () => {
      expiry += 1000;
      return CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: expiry,
        remaining_ttl_ms: 1000,
      });
    });

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // The one permitted immediate attempt.
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // Stopped: no further attempts ever.
        await vi.advanceTimersByTimeAsync(120_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 86_400_000 },
    );
    expect(result).toBe("ok");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("retry-safety budget"),
    );
    warnSpy.mockRestore();

    vi.useRealTimers();
  });

  it("remaining_ttl_ms: max-lead clamp schedules at cap minus reserve — no collapse, no clamp warn", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    // Maximum-lead clamp with the authoritative field: the server holds
    // the lease at L=30000 and SAYS so. Beats land at L minus the
    // retry reserve (2*7000 + 1000 = 15000) — no cadence collapse, no
    // heuristic guessing, and no clamp warn on the field path.
    const e0 = 5_000_000_000;
    const t0 = Date.now();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-field-lead",
        affected_scopes: [],
        expires_at_ms: e0,
        remaining_ttl_ms: 30000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    client.extendReservation.mockImplementation(async () =>
      CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: e0 + (Date.now() - t0),
        remaining_ttl_ms: 30000,
      }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // First delay = max(0, 30000 - (2*7000 + 1000)) = 15000.
        await vi.advanceTimersByTimeAsync(14_999);
        expect(client.extendReservation).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // Zero-grant responses (expiry tracks elapsed) do NOT collapse or
        // hold anything — the schedule stays exactly 15000 per beat.
        await vi.advanceTimersByTimeAsync(14_999);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");

    // No lead-clamp warn on the field path.
    const clampWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("clamp lease lead"),
    );
    expect(clampWarns).toHaveLength(0);
    warnSpy.mockRestore();

    vi.useRealTimers();
  });

  it("remaining_ttl_ms disappearing mid-flight: heuristic resumes from maintained bookkeeping", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-field-gone",
        affected_scopes: [],
        expires_at_ms: e0,
        remaining_ttl_ms: 60000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    // Beat 1's response carries the field; beat 2's does not (proxy
    // strips it / mixed-version fleet). The heuristic must resume from
    // the bookkeeping that kept running under field mode.
    let calls = 0;
    client.extendReservation.mockImplementation(async () => {
      calls += 1;
      const body: Record<string, unknown> = {
        status: "ACTIVE",
        expires_at_ms: e0 + 60000 * calls,
      };
      if (calls === 1) body.remaining_ttl_ms = 60000;
      return CyclesResponse.success(200, body);
    });

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Beat 1 at 45s (field schedule from create: 60000 - 15000).
        await vi.advanceTimersByTimeAsync(45_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // Beat 2 at 90s (field schedule from beat 1's response); its
        // response has NO field -> heuristic takes over: the measured
        // 60000 grant (>= 0.9x ttl, a real per-extend amount) re-derives
        // the cadence to clamp(60000/2, 500, 30000) = 30000.
        await vi.advanceTimersByTimeAsync(45_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        // Beat 3 lands 30s later on the heuristic cadence (leadMin =
        // 120000 - 120000 = 0 < 1.5x lastGrant -> extend).
        await vi.advanceTimersByTimeAsync(29_999);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");

    vi.useRealTimers();
  });

  it("remaining_ttl_ms: transient failure retries with the SAME key at min(30s, lead/4, retry_window)", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-field-503",
        affected_scopes: [],
        expires_at_ms: e0,
        remaining_ttl_ms: 60000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    let calls = 0;
    client.extendReservation.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return CyclesResponse.httpError(503, "Service unavailable");
      return CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: e0 + 60000,
        remaining_ttl_ms: 60000,
      });
    });

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Beat 1 at 45s fails transiently. Recovery recomputes from the
        // create response's lead:
        //   lead   = 60000 - 45000 elapsed        = 15000
        //   window = 15000 - 7000 - 1000          = 7000 (>= 0 -> retry)
        //   delay  = min(30000, 15000/4, 7000)    = 3750, SAME key.
        await vi.advanceTimersByTimeAsync(45_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3_749);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");

    // The retry reuses the SAME idempotency key as the failed attempt.
    const keys = client.extendReservation.mock.calls.map((c: any[]) => c[1].idempotency_key);
    expect(keys[1]).toBe(keys[0]);
    warnSpy.mockRestore();

    vi.useRealTimers();
  });

  it("remaining_ttl_ms: ambiguous 2xx is NOT applied — same-key recovery like a transient failure", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-field-amb",
        affected_scopes: [],
        expires_at_ms: e0,
        remaining_ttl_ms: 60000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    // Beat 1 gets a 200 whose body is NOT a schema-valid
    // ReservationExtendResponse (expires_at_ms missing): on the primary
    // path that is AMBIGUOUS — no proof the extend applied — and must be
    // recovered with the SAME idempotency key, never used for
    // scheduling. The same strict predicate applies to fieldless fallback.
    let calls = 0;
    client.extendReservation.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return CyclesResponse.success(200, { status: "ACTIVE" });
      }
      return CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: e0 + 60000,
        remaining_ttl_ms: 60000,
      });
    });

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Beat 1 at 45s -> ambiguous. Recovery: lead = 60000 - 45000 =
        // 15000; window = 15000 - 8000 = 7000; delay = min(30000, 3750,
        // 7000) = 3750.
        await vi.advanceTimersByTimeAsync(45_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3_749);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");

    const keys = client.extendReservation.mock.calls.map((c: any[]) => c[1].idempotency_key);
    expect(keys[1]).toBe(keys[0]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ambiguous 2xx"),
    );
    warnSpy.mockRestore();

    vi.useRealTimers();
  });

  it("remaining_ttl_ms recovery loop: repeated same-key retries while retry_window >= 0, then stop", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-field-loop",
        affected_scopes: [],
        expires_at_ms: e0,
        remaining_ttl_ms: 60000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    // Every extend fails 503. Recovery recomputes lead/window from the
    // SAME last schema-valid response (the create) on every failure:
    //   attempt 1 @45000: lead 15000, window 7000 -> delay 3750
    //   attempt 2 @48750: lead 11250, window 3250 -> delay 2812
    //   attempt 3 @51562: lead  8438, window  438 -> delay  438
    //   attempt 4 @52000: lead  8000, window    0 -> one immediate retry
    //   attempt 5 @52001: lead  7999, window   -1 -> STOP and surface
    //                     (no complete retry plus margin fits).
    client.extendReservation.mockResolvedValue(
      CyclesResponse.httpError(503, "Service unavailable"),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        await vi.advanceTimersByTimeAsync(45_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3_750);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(2_812);
        expect(client.extendReservation).toHaveBeenCalledTimes(3);
        // Attempt 4 fires at 52000 (window hits exactly 0 there), which
        // permits ONE immediate retry: attempt 5 fires right after, and
        // its failure finds a negative window -> permanent stop.
        await vi.advanceTimersByTimeAsync(439);
        expect(client.extendReservation).toHaveBeenCalledTimes(5);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(5);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");

    // Every recovery attempt reused the SAME idempotency key.
    const keys = client.extendReservation.mock.calls.map((c: any[]) => c[1].idempotency_key);
    for (const k of keys) {
      expect(k).toBe(keys[0]);
    }
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("cannot hold one complete retry"),
    );
    warnSpy.mockRestore();

    vi.useRealTimers();
  });

  it("remaining_ttl_ms: 429 Retry-After is honored exactly when it fits the retry window", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-field-429",
        affected_scopes: [],
        expires_at_ms: e0,
        remaining_ttl_ms: 60000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    let calls = 0;
    client.extendReservation.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return CyclesResponse.httpError(
          429,
          "busy",
          { error: "LIMIT_EXCEEDED", message: "slow down", request_id: "r" },
          { "retry-after": "2" },
        );
      }
      return CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: e0 + 60000,
        remaining_ttl_ms: 60000,
      });
    });

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Beat 1 at 45s is rate limited. Window = 15000 - 8000 = 7000;
        // Retry-After 2s -> 2000ms <= 7000 -> retry EXACTLY 2000ms later
        // (never earlier), same key.
        await vi.advanceTimersByTimeAsync(45_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(client.extendReservation).toHaveBeenCalledTimes(2);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");

    const keys = client.extendReservation.mock.calls.map((c: any[]) => c[1].idempotency_key);
    expect(keys[1]).toBe(keys[0]);
    warnSpy.mockRestore();

    vi.useRealTimers();
  });

  it("remaining_ttl_ms: 429 Retry-After exceeding the retry window stops the heartbeat", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-field-429x",
        affected_scopes: [],
        expires_at_ms: e0,
        remaining_ttl_ms: 60000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    // Retry-After 8s = 8000ms > window 7000ms: honoring it would land
    // past the safe retry window, and retrying earlier would violate
    // throttling — stop and surface instead.
    client.extendReservation.mockResolvedValue(
      CyclesResponse.httpError(
        429,
        "busy",
        { error: "LIMIT_EXCEEDED", message: "slow down", request_id: "r" },
        { "retry-after": "8" },
      ),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        await vi.advanceTimersByTimeAsync(45_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Retry-After"),
    );
    warnSpy.mockRestore();

    vi.useRealTimers();
  });

  it("remaining_ttl_ms: any other 4xx stops the heartbeat without rotating the idempotency key", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-field-4xx",
        affected_scopes: [],
        expires_at_ms: e0,
        remaining_ttl_ms: 60000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    // A non-permanent, non-429 client error: retrying the UNCHANGED
    // request cannot fix it, and rotating the key to force it through is
    // forbidden — stop and surface.
    client.extendReservation.mockResolvedValue(
      CyclesResponse.httpError(400, "Bad request", {
        error: "INVALID_REQUEST",
        message: "bad",
        request_id: "r",
      }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        await vi.advanceTimersByTimeAsync(45_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // No retry, with the same or any other key.
        await vi.advanceTimersByTimeAsync(300_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("client error"),
    );
    warnSpy.mockRestore();

    vi.useRealTimers();
  });

  it("remaining_ttl_ms: unexpected 3xx stops instead of entering recovery", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-field-3xx",
        affected_scopes: [],
        expires_at_ms: 1_000_000_000,
        remaining_ttl_ms: 60000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    client.extendReservation.mockResolvedValue(
      CyclesResponse.httpError(302, "Redirect"),
    );

    const lifecycle = new AsyncCyclesLifecycle(
      client as any,
      makeRetryEngine(),
      { tenant: "acme" },
    );
    await lifecycle.execute(
      async () => {
        await vi.advanceTimersByTimeAsync(45_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unexpected HTTP status 302"),
    );
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("remaining_ttl_ms: an unbounded request timeout yields zero-delay scheduling — one immediate attempt, then stop (no silent fallback)", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // An unbounded per-attempt timeout makes attempt_budget infinite:
    // no lease can provably hold a full failed attempt plus retry, so
    // next_delay is always 0. The zero-delay guard permits exactly one
    // immediate fresh extension and then stops — it must NOT silently
    // downgrade to the fieldless fallback.
    const client = {
      config: new CyclesConfig({
        baseUrl: "http://localhost",
        apiKey: "key",
        connectTimeout: Infinity,
      }),
      createReservation: vi.fn(),
      commitReservation: vi.fn(),
      releaseReservation: vi.fn(),
      extendReservation: vi.fn(),
    };
    const e0 = 1_000_000_000;
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-field-inf",
        affected_scopes: [],
        expires_at_ms: e0,
        remaining_ttl_ms: 60000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    client.extendReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: e0 + 60000,
        remaining_ttl_ms: 60000,
      }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // The one permitted immediate attempt.
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // Stopped — and crucially NOT beating on the fallback cadence.
        await vi.advanceTimersByTimeAsync(300_000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("retry-safety budget"),
    );
    warnSpy.mockRestore();

    vi.useRealTimers();
  });

  it("heartbeat stops permanently on TENANT_CLOSED", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-closed",
        affected_scopes: [],
        expires_at_ms: 1_000_000_000,
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    client.extendReservation.mockResolvedValue(
      CyclesResponse.httpError(403, "Tenant closed", { error: "TENANT_CLOSED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    const result = await lifecycle.execute(
      async () => {
        // Beat 1 (immediate) is rejected with TENANT_CLOSED.
        await vi.advanceTimersByTimeAsync(0);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        // Tenant closure is irreversible — no further attempts.
        await vi.advanceTimersByTimeAsync(120000);
        expect(client.extendReservation).toHaveBeenCalledTimes(1);
        return "ok";
      },
      [],
      { estimate: 1000, ttlMs: 60000 },
    );
    expect(result).toBe("ok");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("permanently rejected"),
    );

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
      actual: (result) => (result as number) * 100,
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

  it("rejects missing required actual before reserving or running the action", async () => {
    const client = makeMockClient();
    const retryEngine = makeRetryEngine();
    const scheduleEventSpy = vi.spyOn(retryEngine, "scheduleEvent");
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });
    const action = vi.fn(async () => "result");

    await expect(
      lifecycle.execute(action, [], {
        estimate: 1000,
        useEstimateIfActualNotProvided: false,
      }),
    ).rejects.toThrow("actual expression is required");
    expect(action).not.toHaveBeenCalled();
    expect(client.createReservation).not.toHaveBeenCalled();
    expect(client.commitReservation).not.toHaveBeenCalled();
    expect(scheduleEventSpy).not.toHaveBeenCalled();
    expect(client.releaseReservation).not.toHaveBeenCalled();
  });

  it("commits the estimate when an actual callback fails after the action", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-actual-fallback",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const lifecycle = new AsyncCyclesLifecycle(client as any, makeRetryEngine(), {
      tenant: "acme",
    });

    await expect(
      lifecycle.execute(async () => "spent", [], {
        estimate: 1000,
        actual: () => {
          throw new Error("usage parser failed");
        },
      }),
    ).resolves.toBe("spent");

    const commitBody = client.commitReservation.mock.calls[0][1];
    expect(commitBody.actual).toEqual({ unit: "USD_MICROCENTS", amount: 1000 });
    expect(commitBody.metadata).toEqual({ actual_source: "estimate" });
    expect(client.releaseReservation).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Actual evaluation failed"),
      expect.any(Error),
    );
  });

  it("commits the estimate when an actual callback returns a non-finite amount", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-invalid-actual",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const lifecycle = new AsyncCyclesLifecycle(client as any, makeRetryEngine(), {
      tenant: "acme",
    });
    await lifecycle.execute(async () => "spent", [], {
      estimate: 1000,
      actual: () => Number.NaN,
    });

    const commitBody = client.commitReservation.mock.calls[0][1];
    expect(commitBody.actual.amount).toBe(1000);
    expect(commitBody.metadata.actual_source).toBe("estimate");
    expect(client.releaseReservation).not.toHaveBeenCalled();
  });

  it("does not release when durable settlement setup fails after the action", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-journal-fail",
        affected_scopes: [],
      }),
    );

    const retryEngine = makeRetryEngine();
    vi.spyOn(retryEngine, "persistPending").mockImplementation(() => {
      throw new Error("journal unavailable");
    });
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, {
      tenant: "acme",
    });

    await expect(
      lifecycle.execute(async () => "spent", [], { estimate: 1000 }),
    ).rejects.toThrow("journal unavailable");
    expect(client.commitReservation).not.toHaveBeenCalled();
    expect(client.releaseReservation).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("not releasing known spend"),
      expect.any(Error),
    );
  });

  // --- estimate-committed-as-actual marker tests ---

  it("marks metadata.actual_source=estimate when the estimate fallback is committed", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-est",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    // No `actual` configured — the estimate is committed as actual.
    await lifecycle.execute(
      async () => {
        const ctx = getCyclesContext()!;
        ctx.commitMetadata = { model: "gpt-4o" };
        return "ok";
      },
      [],
      { estimate: 1000 },
    );

    const commitBody = client.commitReservation.mock.calls[0][1];
    expect(commitBody.actual.amount).toBe(1000);
    // Marker merged into existing commit metadata
    expect(commitBody.metadata).toEqual({
      model: "gpt-4o",
      actual_source: "estimate",
    });
    expect(debugSpy).toHaveBeenCalledOnce();
    debugSpy.mockRestore();
  });

  it("creates metadata for the marker when no commit metadata exists", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-est-2",
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
    expect(commitBody.metadata).toEqual({ actual_source: "estimate" });
    debugSpy.mockRestore();
  });

  it("does not add the marker when an explicit actual is provided", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-real",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const retryEngine = makeRetryEngine();
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await lifecycle.execute(async () => "ok", [], { estimate: 1000, actual: 777 });

    const commitBody = client.commitReservation.mock.calls[0][1];
    expect(commitBody.metadata).toBeUndefined();
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it("carries the marker into the /v1/events fallback body when the reservation expired", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-est-exp",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(410, "Gone", {
        error: "RESERVATION_EXPIRED",
        message: "Reservation expired",
        request_id: "req-1",
      }),
    );

    const retryEngine = makeRetryEngine();
    // Stubbed: this test asserts the fallback body content, not the loop.
    const scheduleEventSpy = vi
      .spyOn(retryEngine, "scheduleEvent")
      .mockImplementation(() => {});
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await lifecycle.execute(async () => "ok", [], { estimate: 1000 });

    expect(scheduleEventSpy).toHaveBeenCalledOnce();
    const eventBody = scheduleEventSpy.mock.calls[0][1] as Record<string, unknown>;
    const metadata = eventBody.metadata as Record<string, unknown>;
    expect(metadata.actual_source).toBe("estimate");
    expect(metadata.recovered_reservation_id).toBe("r-est-exp");
    expect(metadata.recovery_reason).toBe("commit_after_reservation_expired");
    debugSpy.mockRestore();
    warnSpy.mockRestore();
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
      { estimate: 1000, actual: 900 },
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

  it("journals instead of releasing when the error code is truly missing", async () => {
    // A 4xx without a recognized error code is unclassifiable: releasing
    // would return budget for spend that already happened.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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

    const retryEngine = makeRetryEngine();
    // Stubbed: this test asserts routing, not the background loop itself.
    const scheduleSpy = vi
      .spyOn(retryEngine, "schedule")
      .mockImplementation(() => {});
    const lifecycle = new AsyncCyclesLifecycle(client as any, retryEngine, { tenant: "acme" });

    await lifecycle.execute(async () => "ok", [], { estimate: 1000 });

    expect(scheduleSpy).toHaveBeenCalledOnce();
    expect(client.releaseReservation).not.toHaveBeenCalled();
    errorSpy.mockRestore();
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

describe("dynamic subject and action fields", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupClient() {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-dyn",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );
    return client;
  }

  it("resolves callable subject field to per-call value", async () => {
    const client = setupClient();
    const lifecycle = new AsyncCyclesLifecycle(client as any, makeRetryEngine(), {});

    await lifecycle.execute(async () => "ok", [{ workspaceId: "ws-42" }], {
      estimate: 1,
      workspace: (req) => (req as { workspaceId: string }).workspaceId,
    });

    const body = client.createReservation.mock.calls[0][0];
    expect(body.subject.workspace).toBe("ws-42");
  });

  it("falls through to client default when callable subject returns undefined", async () => {
    const client = setupClient();
    const lifecycle = new AsyncCyclesLifecycle(client as any, makeRetryEngine(), {
      workspace: "default-ws",
    });

    await lifecycle.execute(async () => "ok", [], {
      estimate: 1,
      workspace: () => undefined,
    });

    const body = client.createReservation.mock.calls[0][0];
    expect(body.subject.workspace).toBe("default-ws");
  });

  it("keeps static subject string working (regression)", async () => {
    const client = setupClient();
    const lifecycle = new AsyncCyclesLifecycle(client as any, makeRetryEngine(), {});

    await lifecycle.execute(async () => "ok", [], {
      estimate: 1,
      workspace: "production",
    });

    const body = client.createReservation.mock.calls[0][0];
    expect(body.subject.workspace).toBe("production");
  });

  it("propagates errors thrown by subject callable before reservation", async () => {
    const client = setupClient();
    const lifecycle = new AsyncCyclesLifecycle(client as any, makeRetryEngine(), {});

    await expect(
      lifecycle.execute(async () => "ok", [], {
        estimate: 1,
        workspace: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    expect(client.createReservation).not.toHaveBeenCalled();
  });

  it("resolves all six subject fields with mixed callables and statics", async () => {
    const client = setupClient();
    const lifecycle = new AsyncCyclesLifecycle(client as any, makeRetryEngine(), {});

    type Arg = {
      tenantId: string;
      wsId: string;
      appId: string;
      flowId: string;
      agentId: string;
      toolsetId: string;
    };
    const arg: Arg = {
      tenantId: "t",
      wsId: "w",
      appId: "a",
      flowId: "f",
      agentId: "ag",
      toolsetId: "ts",
    };

    await lifecycle.execute(async () => "ok", [arg], {
      estimate: 1,
      tenant: (a) => (a as Arg).tenantId,
      workspace: (a) => (a as Arg).wsId,
      app: "static-app",
      workflow: (a) => (a as Arg).flowId,
      agent: "static-agent",
      toolset: (a) => (a as Arg).toolsetId,
    });

    const subject = client.createReservation.mock.calls[0][0].subject;
    expect(subject).toEqual({
      tenant: "t",
      workspace: "w",
      app: "static-app",
      workflow: "f",
      agent: "static-agent",
      toolset: "ts",
    });
  });

  it("resolves callable actionKind to per-call value", async () => {
    const client = setupClient();
    const lifecycle = new AsyncCyclesLifecycle(client as any, makeRetryEngine(), {
      tenant: "acme",
    });

    await lifecycle.execute(async () => "ok", [{ kind: "llm.completion" }], {
      estimate: 1,
      actionKind: (req) => (req as { kind: string }).kind,
    });

    const body = client.createReservation.mock.calls[0][0];
    expect(body.action.kind).toBe("llm.completion");
  });

  it("resolves callable actionName to per-call value", async () => {
    const client = setupClient();
    const lifecycle = new AsyncCyclesLifecycle(client as any, makeRetryEngine(), {
      tenant: "acme",
    });

    await lifecycle.execute(async () => "ok", [{ model: "gpt-4o" }], {
      estimate: 1,
      actionName: (req) => (req as { model: string }).model,
    });

    const body = client.createReservation.mock.calls[0][0];
    expect(body.action.name).toBe("gpt-4o");
  });

  it("falls through to \"unknown\" when callable action field returns undefined", async () => {
    const client = setupClient();
    const lifecycle = new AsyncCyclesLifecycle(client as any, makeRetryEngine(), {
      tenant: "acme",
    });

    await lifecycle.execute(async () => "ok", [], {
      estimate: 1,
      actionKind: () => undefined,
      actionName: () => undefined,
    });

    const body = client.createReservation.mock.calls[0][0];
    expect(body.action.kind).toBe("unknown");
    expect(body.action.name).toBe("unknown");
  });

  it("keeps static actionKind / actionName working (regression)", async () => {
    const client = setupClient();
    const lifecycle = new AsyncCyclesLifecycle(client as any, makeRetryEngine(), {
      tenant: "acme",
    });

    await lifecycle.execute(async () => "ok", [], {
      estimate: 1,
      actionKind: "llm.completion",
      actionName: "gpt-4",
    });

    const body = client.createReservation.mock.calls[0][0];
    expect(body.action.kind).toBe("llm.completion");
    expect(body.action.name).toBe("gpt-4");
  });

  it("passes actionTags through to the reservation body", async () => {
    const client = setupClient();
    const lifecycle = new AsyncCyclesLifecycle(client as any, makeRetryEngine(), {
      tenant: "acme",
    });

    await lifecycle.execute(async () => "ok", [], {
      estimate: 1,
      actionTags: ["llm", "completion"],
    });

    const body = client.createReservation.mock.calls[0][0];
    expect(body.action.tags).toEqual(["llm", "completion"]);
  });
});
