import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { reserveForStream } from "../src/streaming.js";
import { CyclesConfig } from "../src/config.js";
import { authFingerprint, defaultJournalDir } from "../src/journal.js";
import { CyclesResponse } from "../src/response.js";
import { BudgetExceededError, CyclesError, TenantClosedError } from "../src/exceptions.js";

function makeMockClient(
  configOverrides: Partial<ConstructorParameters<typeof CyclesConfig>[0]> = {},
) {
  return {
    config: new CyclesConfig({ baseUrl: "http://localhost", apiKey: "key", ...configOverrides }),
    createReservation: vi.fn(),
    commitReservation: vi.fn(),
    releaseReservation: vi.fn(),
    extendReservation: vi.fn(),
    createEvent: vi.fn(),
  };
}

/** Journal files for the mock client's (server, key) identity. */
function journalFiles(): string[] {
  const dir = path.join(defaultJournalDir(), authFingerprint("http://localhost", "key"));
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => n.endsWith(".json"))
    : [];
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

  it("throws TenantClosedError on TENANT_CLOSED create failure", async () => {
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

    await expect(
      reserveForStream({
        client: client as any,
        estimate: 10000,
        tenant: "acme",
      }),
    ).rejects.toBeInstanceOf(TenantClosedError);
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

  // --- Race-safety / once-only finalization tests ---

  it("finalized is false initially, true after commit", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-fin-1",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    expect(handle.finalized).toBe(false);
    await handle.commit(500);
    expect(handle.finalized).toBe(true);
  });

  it("finalized is true after release", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-fin-2",
        affected_scopes: [],
      }),
    );
    client.releaseReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "RELEASED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    expect(handle.finalized).toBe(false);
    await handle.release();
    expect(handle.finalized).toBe(true);
  });

  it("finalized is true after dispose", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-fin-3",
        affected_scopes: [],
      }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    expect(handle.finalized).toBe(false);
    handle.dispose();
    expect(handle.finalized).toBe(true);
  });

  it("commit then release is no-op", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-race-1",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    await handle.commit(800);
    await handle.release("too_late"); // Should be a no-op

    expect(client.commitReservation).toHaveBeenCalledOnce();
    expect(client.releaseReservation).not.toHaveBeenCalled();
  });

  it("release then commit throws", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-race-2",
        affected_scopes: [],
      }),
    );
    client.releaseReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "RELEASED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    await handle.release("aborted");
    await expect(handle.commit(800)).rejects.toThrow("already finalized");
    expect(client.commitReservation).not.toHaveBeenCalled();
  });

  it("double commit throws on second call", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-race-3",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    await handle.commit(800);
    await expect(handle.commit(900)).rejects.toBeInstanceOf(CyclesError);
    expect(client.commitReservation).toHaveBeenCalledOnce();
  });

  it("double release only calls server once", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-race-4",
        affected_scopes: [],
      }),
    );
    client.releaseReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "RELEASED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    await handle.release("error_1");
    await handle.release("error_2"); // Should be a no-op

    expect(client.releaseReservation).toHaveBeenCalledOnce();
  });

  it("dispose then commit throws", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-race-5",
        affected_scopes: [],
      }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    handle.dispose();
    await expect(handle.commit(500)).rejects.toThrow("already finalized");
    expect(client.commitReservation).not.toHaveBeenCalled();
  });

  it("dispose then release is no-op", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-race-6",
        affected_scopes: [],
      }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    handle.dispose();
    await handle.release("too_late"); // Should be a no-op

    expect(client.releaseReservation).not.toHaveBeenCalled();
  });

  // --- Heartbeat tests ---

  it("heartbeat extends reservation on interval", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb",
        affected_scopes: [],
      }),
    );
    client.extendReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: Date.now() + 120000 }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Advance past heartbeat interval (ttlMs/2 = 30000)
    await vi.advanceTimersByTimeAsync(31000);
    expect(client.extendReservation).toHaveBeenCalled();

    await handle.commit(500);
    vi.useRealTimers();
  });

  it("heartbeat swallows extend failures gracefully", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-fail",
        affected_scopes: [],
      }),
    );
    client.extendReservation.mockRejectedValue(new Error("extend failed"));
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Should not throw even though extend fails
    await vi.advanceTimersByTimeAsync(31000);
    expect(client.extendReservation).toHaveBeenCalled();

    await handle.commit(500);
    vi.useRealTimers();
  });

  it("heartbeat extends on the first beat, skips the second, extends on the third", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-alt",
        affected_scopes: [],
      }),
    );
    client.extendReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: Date.now() + 120000 }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Beat 1 at 30s: extends (only ttl/2 of lifetime left)
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    // Beat 2 at 60s: skipped (previous extend succeeded)
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    // Beat 3 at 90s: extends again
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);

    // Body still requests the full ttlMs each time
    const extendBody = client.extendReservation.mock.calls[0][1];
    expect(extendBody.extend_by_ms).toBe(60000);
    expect(extendBody.idempotency_key).toBeDefined();

    await handle.commit(500);
    vi.useRealTimers();
  });

  it("heartbeat retries on the very next beat after a failed extend", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-retry",
        affected_scopes: [],
      }),
    );
    // Beat 1 throws, beat 2 gets a non-2xx, beat 3 succeeds, beat 4 skipped.
    client.extendReservation
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(CyclesResponse.httpError(500, "Server error"))
      .mockResolvedValue(
        CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: Date.now() + 120000 }),
      );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Beat 1: attempt fails (thrown)
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    // Beat 2: retried immediately, fails again (non-2xx)
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);
    // Beat 3: retried immediately, succeeds
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(3);
    // Beat 4: skipped after the success
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(3);

    await handle.commit(500);
    vi.useRealTimers();
  });

  // --- Missing reservation_id guard ---

  it("throws when reservation_id missing from success response", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        // No reservation_id
        affected_scopes: [],
      }),
    );

    await expect(
      reserveForStream({
        client: client as any,
        estimate: 1000,
        tenant: "acme",
      }),
    ).rejects.toThrow("reservation_id missing");
  });

  // --- Commit with metrics and metadata ---

  it("commit includes metadata in wire format", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-meta",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    await handle.commit(
      800,
      { tokensInput: 50, tokensOutput: 100 },
      { model: "gpt-4o", provider: "openai" },
    );

    const [, commitBody] = client.commitReservation.mock.calls[0];
    expect(commitBody.metrics).toEqual({
      tokens_input: 50,
      tokens_output: 100,
    });
    expect(commitBody.metadata).toEqual({ model: "gpt-4o", provider: "openai" });
  });

  it("commit omits empty metrics", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-empty-m",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    await handle.commit(800, {});

    const [, commitBody] = client.commitReservation.mock.calls[0];
    expect(commitBody.metrics).toBeUndefined();
  });

  // --- Release error swallowing ---

  it("release swallows client errors silently", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-release-err",
        affected_scopes: [],
      }),
    );
    client.releaseReservation.mockRejectedValue(new Error("server exploded"));

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    // Should not throw
    await handle.release("abort");
    expect(handle.finalized).toBe(true);
  });

  it("release uses default reason when not specified", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-default-reason",
        affected_scopes: [],
      }),
    );
    client.releaseReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "RELEASED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    await handle.release();

    const [, releaseBody] = client.releaseReservation.mock.calls[0];
    expect(releaseBody.reason).toBe("stream_aborted");
  });

  // --- Bug fix regression: commit failure recovery ---

  it("commit journals the spend and resolves on transport failure", async () => {
    // retryEnabled: false keeps the background loop out of the test; the
    // journal entry alone proves durability.
    const client = makeMockClient({ retryEnabled: false });
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-retry",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockRejectedValueOnce(new Error("ECONNRESET"));

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    // Spend already happened: the SDK owns recovery, the caller is done.
    await handle.commit(500);
    expect(handle.finalized).toBe(true);
    expect(journalFiles()).toHaveLength(1);
  });

  it("commit recovers an expired reservation via the event fallback", async () => {
    const client = makeMockClient({ retryEnabled: false });
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-4xx",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(409, "Reservation expired", {
        error: "RESERVATION_EXPIRED",
        message: "Reservation has expired",
        request_id: "req-1",
      }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    // The server already returned the budget to the pool: the spend is
    // re-recorded via POST /v1/events, not surfaced to the caller.
    await handle.commit(500);
    expect(handle.finalized).toBe(true);

    const files = journalFiles();
    expect(files).toHaveLength(1);
    const record = JSON.parse(
      fs.readFileSync(
        path.join(defaultJournalDir(), authFingerprint("http://localhost", "key"), files[0]),
        "utf-8",
      ),
    );
    expect(record.mode).toBe("event");
    expect(record.event_fallback_body.metadata.recovered_reservation_id).toBe("r-4xx");
    expect(record.event_fallback_body.subject).toEqual({ tenant: "acme" });
  });

  it("genuine commit rejection throws and allows release as fallback", async () => {
    const client = makeMockClient({ retryEnabled: false });
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-fallback",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(409, "Unit mismatch", {
        error: "UNIT_MISMATCH",
        message: "Unit mismatch",
        request_id: "req-2",
      }),
    );
    client.releaseReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "RELEASED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    // A malformed commit is the caller's to correct — not journaled.
    await expect(handle.commit(500)).rejects.toThrow("Commit failed with status 409");
    expect(handle.finalized).toBe(false);
    expect(journalFiles()).toHaveLength(0);

    // Caller falls back to release
    await handle.release("commit_failed");
    expect(handle.finalized).toBe(true);
    expect(client.releaseReservation).toHaveBeenCalledOnce();
  });

  it("commit treats a bodyless 410 as expired and uses the event fallback", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient({ retryEnabled: false });
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-410",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(410, "Gone"), // no JSON body at all
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    await handle.commit(500);
    expect(handle.finalized).toBe(true);

    const files = journalFiles();
    expect(files).toHaveLength(1);
    const record = JSON.parse(
      fs.readFileSync(
        path.join(defaultJournalDir(), authFingerprint("http://localhost", "key"), files[0]),
        "utf-8",
      ),
    );
    expect(record.mode).toBe("event");
    expect(record.event_fallback_body.metadata.recovered_reservation_id).toBe("r-410");
    warnSpy.mockRestore();
  });

  it("commit journals instead of throwing on an unrecognized 4xx code", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient({ retryEnabled: false });
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-future",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(400, "weird", {
        error: "SOME_FUTURE_CODE",
        message: "m",
        request_id: "r",
      }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    // Unclassifiable: the spend already happened — resolve, journal, retain.
    await handle.commit(500);
    expect(handle.finalized).toBe(true);
    expect(journalFiles()).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unclassifiable"));
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("commit journals instead of throwing on a codeless 4xx", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient({ retryEnabled: false });
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-codeless",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(400, "Bad request"),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    await handle.commit(500);
    expect(handle.finalized).toBe(true);
    expect(journalFiles()).toHaveLength(1);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("commit journals with the Retry-After floor on a rate-limited response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient({ retryEnabled: false });
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-429",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(
        429,
        "busy",
        { error: "LIMIT_EXCEEDED", message: "slow down", request_id: "r" },
        { "retry-after": "3" },
      ),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    await handle.commit(500);
    expect(handle.finalized).toBe(true);
    expect(client.releaseReservation).not.toHaveBeenCalled();

    const files = journalFiles();
    expect(files).toHaveLength(1);
    const record = JSON.parse(
      fs.readFileSync(
        path.join(defaultJournalDir(), authFingerprint("http://localhost", "key"), files[0]),
        "utf-8",
      ),
    );
    expect(record.not_before_ms).toBeGreaterThan(Date.now());
    warnSpy.mockRestore();
  });

  it("commit journals instead of releasing on an authentication failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient({ retryEnabled: false });
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-401",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(401, "Unauthorized"),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    await handle.commit(500);
    expect(handle.finalized).toBe(true);
    expect(client.releaseReservation).not.toHaveBeenCalled();
    expect(journalFiles()).toHaveLength(1);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("commit resolves quietly when the reservation is already settled", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient({ retryEnabled: false });
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-settled",
        affected_scopes: [],
      }),
    );
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(409, "Finalized", {
        error: "RESERVATION_FINALIZED",
        message: "Finalized",
        request_id: "r",
      }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
    });

    await handle.commit(500);
    expect(handle.finalized).toBe(true);
    expect(journalFiles()).toHaveLength(0);
    expect(client.releaseReservation).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("passes gracePeriodMs and actionTags in request body", async () => {
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-opts",
        affected_scopes: [],
      }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      gracePeriodMs: 5000,
      actionTags: ["streaming", "llm"],
      dimensions: { env: "prod" },
    });

    const createBody = client.createReservation.mock.calls[0][0];
    expect(createBody.grace_period_ms).toBe(5000);
    expect(createBody.action.tags).toEqual(["streaming", "llm"]);
    expect(createBody.subject.dimensions).toEqual({ env: "prod" });

    handle.dispose();
  });
});
