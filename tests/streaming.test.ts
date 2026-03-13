import { describe, it, expect, vi, afterEach } from "vitest";
import { reserveForStream } from "../src/streaming.js";
import { CyclesClient } from "../src/client.js";
import { CyclesConfig } from "../src/config.js";
import { CyclesResponse } from "../src/response.js";
import { BudgetExceededError } from "../src/exceptions.js";

function makeClient() {
  const config = new CyclesConfig({ baseUrl: "http://localhost", apiKey: "key", tenant: "acme" });
  return new CyclesClient(config);
}

function makeMockClient() {
  return {
    config: new CyclesConfig({ baseUrl: "http://localhost", apiKey: "key" }),
    createReservation: vi.fn(),
    commitReservation: vi.fn(),
    releaseReservation: vi.fn(),
    extendReservation: vi.fn(),
  };
}

describe("reserveForStream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates reservation and returns handle", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-stream-1",
        affected_scopes: ["tenant:acme"],
        caps: { max_tokens: 4096 },
      }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 5000,
      unit: "USD_MICROCENTS",
      actionKind: "llm.completion",
      actionName: "gpt-4o",
      tenant: "acme",
    });

    expect(handle.reservationId).toBe("r-stream-1");
    expect(handle.decision).toBe("ALLOW");
    expect(handle.caps).toEqual({ maxTokens: 4096 });

    // Verify wire-format request
    const createBody = client.createReservation.mock.calls[0][0];
    expect(createBody.idempotency_key).toBeDefined();
    expect(createBody.estimate).toEqual({ unit: "USD_MICROCENTS", amount: 5000 });
    expect(createBody.action).toEqual({ kind: "llm.completion", name: "gpt-4o" });

    // Cleanup via dispose (simulates startup-failure path)
    handle.dispose();
  });

  it("commits with actual usage and auto-disposes heartbeat", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-stream-2",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 3000,
      tenant: "acme",
    });

    await handle.commit(2500, {
      tokensInput: 100,
      tokensOutput: 200,
      modelVersion: "gpt-4o",
    });

    // No dispose() needed — commit auto-stops the heartbeat
    expect(client.commitReservation).toHaveBeenCalledOnce();
    const [resId, commitBody] = client.commitReservation.mock.calls[0];
    expect(resId).toBe("r-stream-2");
    expect(commitBody.actual).toEqual({ unit: "USD_MICROCENTS", amount: 2500 });
    expect(commitBody.metrics).toEqual({
      tokens_input: 100,
      tokens_output: 200,
      model_version: "gpt-4o",
    });

    // Verify heartbeat stopped: after waiting, no extend calls should appear
    await new Promise((r) => setTimeout(r, 50));
    expect(client.extendReservation).not.toHaveBeenCalled();
  });

  it("releases on abort and auto-disposes heartbeat", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-stream-3",
        affected_scopes: [],
      }),
    );
    client.releaseReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "RELEASED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 3000,
      tenant: "acme",
    });

    await handle.release("user_cancelled");
    // No dispose() needed — release auto-stops the heartbeat
    expect(client.releaseReservation).toHaveBeenCalledOnce();
    const [resId, releaseBody] = client.releaseReservation.mock.calls[0];
    expect(resId).toBe("r-stream-3");
    expect(releaseBody.reason).toBe("user_cancelled");

    // Verify heartbeat stopped
    await new Promise((r) => setTimeout(r, 50));
    expect(client.extendReservation).not.toHaveBeenCalled();
  });

  it("throws on DENY decision", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "DENY",
        affected_scopes: [],
        reason_code: "BUDGET_EXCEEDED",
      }),
    );

    await expect(
      reserveForStream({
        client: client as any,
        estimate: 10000,
        tenant: "acme",
      }),
    ).rejects.toThrow("Reservation denied");
  });

  it("throws on reservation create failure", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.httpError(402, "Budget exceeded", {
        error: "BUDGET_EXCEEDED",
        message: "Insufficient budget",
        request_id: "req-1",
      }),
    );

    await expect(
      reserveForStream({
        client: client as any,
        estimate: 10000,
        tenant: "acme",
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("uses config defaults for subject fields", async () => {
    const client = {
      config: new CyclesConfig({ baseUrl: "http://localhost", apiKey: "key", tenant: "from-config", workspace: "ws-1" }),
      createReservation: vi.fn(),
      commitReservation: vi.fn(),
      releaseReservation: vi.fn(),
      extendReservation: vi.fn(),
    };
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-defaults",
        affected_scopes: [],
      }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      // tenant not specified — should fall back to config
    });

    const createBody = client.createReservation.mock.calls[0][0];
    expect(createBody.subject.tenant).toBe("from-config");
    expect(createBody.subject.workspace).toBe("ws-1");

    handle.dispose();
  });

  it("dispose is idempotent", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-stream-4",
        affected_scopes: [],
      }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    handle.dispose();
    handle.dispose(); // Should not throw
  });
});
