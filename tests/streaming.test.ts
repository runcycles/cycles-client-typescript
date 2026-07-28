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
    // Default: a schema-valid applied extend. Tests that exercise heartbeat
    // behavior override it per scenario.
    extendReservation: vi
      .fn()
      .mockResolvedValue(
        CyclesResponse.success(200, {
          status: "ACTIVE",
          expires_at_ms: 1_000_060_000,
        }),
      ),
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

  it("heartbeat leadMin: immediate first beat, extends beats 1-3, skips beat 4", async () => {
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
    // Each applied extend grants the full ttl relative to current expiry.
    let expiry = e0;
    client.extendReservation.mockImplementation(async () => {
      expiry += 60000;
      return CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: expiry });
    });
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // leadMin = grantsSum - elapsed starts at 0 (initial grant never
    // counted); each measured grant adds 60000, each 30s of elapsed
    // subtracts 30000. Beat 1 fires IMMEDIATELY (delay 0).
    await vi.advanceTimersByTimeAsync(0);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    // Beat 2 at 30s: leadMin 60000-30000=30000 < 1.5*60000 -> extend
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);
    // Beat 3 at 60s: leadMin 120000-60000=60000 < 90000 -> extend
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(3);
    // Beat 4 at 90s: leadMin 180000-90000=90000 >= 90000 -> skip
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(3);
    // Beat 5 at 120s: leadMin 180000-120000=60000 < 90000 -> extend
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(4);

    // Body requests the full REQUESTED ttlMs each time
    for (const call of client.extendReservation.mock.calls) {
      expect(call[1].extend_by_ms).toBe(60000);
    }
    expect(client.extendReservation.mock.calls[0][1].idempotency_key).toBeDefined();

    await handle.commit(500);
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
    // Beat 1 fails transiently; the retry on beat 2 succeeds; beat 3
    // extends again (only one grant has been applied by then).
    let calls = 0;
    client.extendReservation.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return CyclesResponse.httpError(500, "Server error");
      return CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: e0 + 60000 * (calls - 1),
      });
    });
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Beat 1 (immediate): attempt fails (non-2xx)
    await vi.advanceTimersByTimeAsync(0);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    // Beat 2 at 30s: retried, succeeds
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);
    // Beat 3 at 60s: lead still small (one grant applied, leadMin =
    // 60000 - 60000 = 0) -> extends, fresh key
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(3);

    // The retry reuses the SAME idempotency key so a lost response cannot
    // double-extend; success regenerates.
    const keys = client.extendReservation.mock.calls.map((c: any[]) => c[1].idempotency_key);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);

    await handle.commit(500);
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
    let calls = 0;
    client.extendReservation.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return CyclesResponse.httpError(503, "Service unavailable");
      return CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: e0 + 60000 });
    });
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Beat 1 (immediate, delay 0) fails transiently.
    await vi.advanceTimersByTimeAsync(0);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    // The retry must wait the HELD interval min(ttl/2, 30s) = 30s — the 0
    // delay applies to the first schedule only; a 0-delay reschedule
    // would hot-loop against a down server.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);

    // The retry reuses the SAME idempotency key as the unresolved attempt.
    const keys = client.extendReservation.mock.calls.map((c: any[]) => c[1].idempotency_key);
    expect(keys[1]).toBe(keys[0]);
    warnSpy.mockRestore();

    await handle.commit(500);
    vi.useRealTimers();
  });

  it("heartbeat stops permanently on a bare 410 Gone", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-gone",
        affected_scopes: [],
        expires_at_ms: 1_000_000_000,
      }),
    );
    // Bodyless 410: no error code, but the status alone is permanent.
    client.extendReservation.mockResolvedValue(
      CyclesResponse.httpError(410, "Gone"),
    );
    client.releaseReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "RELEASED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Beat 1 (immediate): extend rejected permanently -> heartbeat stops
    await vi.advanceTimersByTimeAsync(0);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    // Subsequent beats: no further extend attempts
    await vi.advanceTimersByTimeAsync(120000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("permanently rejected"),
    );

    await handle.release("expired");
    vi.useRealTimers();
  });

  it("heartbeat without an initial expires_at_ms falls back to requested-ttl grants", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    // Create response carries no expires_at_ms: the first measured grant
    // has no server-frame baseline, so it falls back to the requested ttl;
    // the extend response's expires_at_ms then seeds the baseline and
    // subsequent grants are measured.
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-noref",
        affected_scopes: [],
      }),
    );
    const e1 = 2_000_000_000;
    let calls = 0;
    client.extendReservation.mockImplementation(async () => {
      calls += 1;
      return CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: e1 + 60000 * (calls - 1),
      });
    });
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Grants of 60000 (fallback, then measured) with an immediate first
    // beat and 30s cadence: extends at beats 1-3, skip at beat 4, extend
    // at beat 5.
    await vi.advanceTimersByTimeAsync(0);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(3); // skip
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(4);

    await handle.commit(500);
    vi.useRealTimers();
  });

  it("heartbeat capped grants: immediate first beat, cadence from the measured 1h grant, extend_by stays requested", async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    // Requested 24h, but every grant is capped at 1h. The first beat
    // fires IMMEDIATELY — no bounded delay can be proven safe against an
    // unknowable capped lease — and primes a real measured grant.
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
    let expiry = e0;
    client.extendReservation.mockImplementation(async () => {
      expiry += oneHour;
      return CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: expiry });
    });
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 86_400_000,
    });

    // Beat 1 fires immediately (delay 0) — NOT at requestedTtl/2 = 12h
    // and not even at 30s.
    expect(client.extendReservation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    // The measured 1h grant is a REAL per-extend amount (1h >> 1.25x
    // elapsed 0), so the cadence re-derives to 30min beats and every beat
    // extends while leadMin < 1.5h.
    await vi.advanceTimersByTimeAsync(oneHour / 2);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(oneHour / 2);
    expect(client.extendReservation).toHaveBeenCalledTimes(3);
    // extend_by_ms always requests the REQUESTED 24h — never an estimate.
    for (const call of client.extendReservation.mock.calls) {
      expect(call[1].extend_by_ms).toBe(86_400_000);
    }

    await handle.commit(500);
    vi.useRealTimers();
  });

  it("heartbeat lead clamp: cadence holds at min(ttl/2, 30s), extends every beat, warns once", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    // Maximum-LEAD clamp: the server holds expires_at_ms ~ now + L, so
    // every extend response returns INITIAL + elapsed and successive
    // differences measure ELAPSED time, not lease. The cadence must hold
    // at min(ttl/2, 30s) instead of collapsing to the 500ms floor and
    // burning max_extensions in seconds.
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
    client.extendReservation.mockImplementation(async () =>
      CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: e0 + (Date.now() - t0),
      }),
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

    // Beat 1 (immediate): grant = 0 (expiry unmoved) -> lead-clamp
    // regime: held cadence, warn.
    await vi.advanceTimersByTimeAsync(0);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    // Had the cadence collapsed to the 500ms floor this advance would
    // fire ~60 beats; it fires exactly one, at the held 30s.
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);
    // grant = 30000 = elapsed (ratio 1, inside the 0.75x-1.25x band) ->
    // still lead-clamped: held cadence, extends every beat (leadMin
    // stays ~0 < 1.5x lastGrant).
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.extendReservation).toHaveBeenCalledTimes(4);

    // The lead-clamp warning fires exactly once per heartbeat.
    const clampWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("clamp lease lead"),
    );
    expect(clampWarns).toHaveLength(1);
    expect(String(clampWarns[0][0])).toContain("max_extensions");

    await handle.commit(500);
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
    // Genuine GRANT clamp: every extend grants exactly ttl/4 = 15000.
    let expiry = e0;
    client.extendReservation.mockImplementation(async () => {
      expiry += 15000;
      return CyclesResponse.success(200, { status: "ACTIVE", expires_at_ms: expiry });
    });
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Beats 1-3 extend at the grant-derived 7.5s cadence (elapsed 0 then
    // 7500; grant 15000 misses the 0.75x-1.25x band -> normal regime).
    await vi.advanceTimersByTimeAsync(0);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7500);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7500);
    expect(client.extendReservation).toHaveBeenCalledTimes(3);
    // Beat 4 at 22500: leadMin 45000-22500=22500 >= 1.5*15000 -> skip.
    await vi.advanceTimersByTimeAsync(7500);
    expect(client.extendReservation).toHaveBeenCalledTimes(3);
    // Beat 5 at 30000 extends ACROSS THE DOUBLED GAP: elapsed since the
    // last applied extend (b3@15000) is 15000 = grant, ratio 1 — inside
    // the band -> lands in the hold ONCE (interval becomes the held 30s).
    await vi.advanceTimersByTimeAsync(7500);
    expect(client.extendReservation).toHaveBeenCalledTimes(4);
    // The hold must NOT self-sustain: nothing fires before the held 30s
    // wait elapses...
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

    // The transient hold triggers the clamp warn (once per heartbeat).
    const clampWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("clamp lease lead"),
    );
    expect(clampWarns).toHaveLength(1);
    warnSpy.mockRestore();

    await handle.commit(500);
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
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Enforced per-attempt timeout T = connect 2000 + read 5000 = 7000
    // (test default config). With rtt 0:
    //   attempt_budget = max(7000, 1000, 0) = 7000
    //   safety_margin  = max(1000, 0)       = 1000
    //   retry_reserve  = 2*7000 + 1000      = 15000
    //   first delay    = max(0, 60000 - 15000) = 45000
    // — derived from the create response, NOT an immediate prime.
    await vi.advanceTimersByTimeAsync(44_999);
    expect(client.extendReservation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);
    // Beat 3 at 135s: the heuristic would skip (leadMin 1,865,000 >=
    // 1.5*1,000,000) but field mode bypasses the skip check and extends.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(3);
    for (const call of client.extendReservation.mock.calls) {
      expect(call[1].extend_by_ms).toBe(60000);
    }

    await handle.commit(500);
    vi.useRealTimers();
  });

  it("remaining_ttl_ms zero-delay guard: a lease below the retry reserve gets ONE immediate fresh attempt, then stops", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    // 24h requested, tenant policy caps the lease at 1s and the server
    // says so authoritatively (remaining_ttl_ms=1000). The retry reserve
    // is 2*7000 + 1000 = 15000 > 1000, so next_delay = 0: exactly ONE
    // immediate fresh extension is permitted; when it also yields
    // next_delay = 0, the heartbeat stops and surfaces that the lease is
    // shorter than the retry-safety budget — no tight loop, no silent
    // fallback.
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
    let expiry = e0;
    client.extendReservation.mockImplementation(async () => {
      expiry += 1000;
      return CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: expiry,
        remaining_ttl_ms: 1000,
      });
    });
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 86_400_000,
    });

    // The one permitted immediate attempt.
    await vi.advanceTimersByTimeAsync(0);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    // Stopped: no further attempts ever.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("retry-safety budget"),
    );
    warnSpy.mockRestore();

    await handle.commit(500);
    vi.useRealTimers();
  });

  it("remaining_ttl_ms: max-lead clamp schedules at cap minus reserve — no collapse, no clamp warn", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    // The server holds the lease at L=30000 and SAYS so: beats land at
    // L minus the retry reserve (2*7000 + 1000 = 15000) — no cadence
    // collapse, no clamp warn.
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
    client.extendReservation.mockImplementation(async () =>
      CyclesResponse.success(200, {
        status: "ACTIVE",
        expires_at_ms: e0 + (Date.now() - t0),
        remaining_ttl_ms: 30000,
      }),
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

    const clampWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("clamp lease lead"),
    );
    expect(clampWarns).toHaveLength(0);
    warnSpy.mockRestore();

    await handle.commit(500);
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
    // Beat 1's response carries the field; beat 2's does not. The
    // heuristic must resume from the bookkeeping kept under field mode.
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
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Beat 1 at 45s (field schedule from create: 60000 - 15000).
    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    // Beat 2 at 90s (field schedule); its response has NO field ->
    // heuristic takes over: measured 60000 grant -> 30s cadence.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);
    // Beat 3 lands 30s later on the heuristic cadence.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.extendReservation).toHaveBeenCalledTimes(3);

    await handle.commit(500);
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
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Beat 1 at 45s fails transiently. Recovery recomputes from the
    // create response's lead:
    //   lead   = 60000 - 45000 elapsed     = 15000
    //   window = 15000 - 7000 - 1000       = 7000 (>= 0 -> retry)
    //   delay  = min(30000, 15000/4, 7000) = 3750, SAME key.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_749);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);

    // The retry reuses the SAME idempotency key as the failed attempt.
    const keys = client.extendReservation.mock.calls.map((c: any[]) => c[1].idempotency_key);
    expect(keys[1]).toBe(keys[0]);
    warnSpy.mockRestore();

    await handle.commit(500);
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
    // Beat 1 gets a 200 whose body is NOT a schema-valid
    // ReservationExtendResponse (expires_at_ms missing): AMBIGUOUS on
    // the primary path — same-key recovery, never used for scheduling.
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
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Beat 1 at 45s -> ambiguous. Recovery: lead 15000, window 7000,
    // delay = min(30000, 3750, 7000) = 3750, SAME key.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_749);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);

    const keys = client.extendReservation.mock.calls.map((c: any[]) => c[1].idempotency_key);
    expect(keys[1]).toBe(keys[0]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ambiguous 2xx"),
    );
    warnSpy.mockRestore();

    await handle.commit(500);
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
    // Every extend fails 503; recovery recomputes lead/window from the
    // SAME last schema-valid response (the create) each time:
    // attempts at 45000 (delay 3750), 48750 (2812), 51562 (438),
    // 52000 (window 0 -> one immediate retry), then STOP when no
    // complete retry plus margin fits.
    client.extendReservation.mockResolvedValue(
      CyclesResponse.httpError(503, "Service unavailable"),
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

    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_750);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_812);
    expect(client.extendReservation).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(439);
    expect(client.extendReservation).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(5);

    // Every recovery attempt reused the SAME idempotency key.
    const keys = client.extendReservation.mock.calls.map((c: any[]) => c[1].idempotency_key);
    for (const k of keys) {
      expect(k).toBe(keys[0]);
    }
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("cannot hold one complete retry"),
    );
    warnSpy.mockRestore();

    await handle.commit(500);
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
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Beat 1 at 45s is rate limited. Window = 7000; Retry-After 2s ->
    // 2000ms <= 7000 -> retry EXACTLY 2000ms later, same key.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.extendReservation).toHaveBeenCalledTimes(2);

    const keys = client.extendReservation.mock.calls.map((c: any[]) => c[1].idempotency_key);
    expect(keys[1]).toBe(keys[0]);
    warnSpy.mockRestore();

    await handle.commit(500);
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
    // Retry-After 8s = 8000ms > window 7000ms -> honoring it would land
    // past the safe retry window; retrying earlier would violate
    // throttling — stop and surface.
    client.extendReservation.mockResolvedValue(
      CyclesResponse.httpError(
        429,
        "busy",
        { error: "LIMIT_EXCEEDED", message: "slow down", request_id: "r" },
        { "retry-after": "8" },
      ),
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

    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Retry-After"),
    );
    warnSpy.mockRestore();

    await handle.commit(500);
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
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("client error"),
    );
    warnSpy.mockRestore();

    await handle.commit(500);
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
    client.extendReservation.mockResolvedValue(
      CyclesResponse.httpError(302, "Redirect"),
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

    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unexpected HTTP status 302"),
    );
    warnSpy.mockRestore();

    await handle.commit(500);
    vi.useRealTimers();
  });

  it("heartbeat stops permanently on NOT_FOUND", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient();
    client.createReservation.mockResolvedValue(
      CyclesResponse.success(200, {
        decision: "ALLOW",
        reservation_id: "r-hb-404",
        affected_scopes: [],
        expires_at_ms: 1_000_000_000,
      }),
    );
    client.extendReservation.mockResolvedValue(
      CyclesResponse.httpError(404, "Not found", { error: "NOT_FOUND" }),
    );
    client.releaseReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "RELEASED" }),
    );

    const handle = await reserveForStream({
      client: client as any,
      estimate: 1000,
      tenant: "acme",
      ttlMs: 60000,
    });

    // Beat 1 (immediate) is rejected with NOT_FOUND.
    await vi.advanceTimersByTimeAsync(0);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    // A 404'd reservation never comes back — no further attempts.
    await vi.advanceTimersByTimeAsync(120000);
    expect(client.extendReservation).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("permanently rejected"),
    );

    await handle.release("gone");
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
