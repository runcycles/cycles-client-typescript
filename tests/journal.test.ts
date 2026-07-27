/** Tests for the durable commit journal, retry-engine durability, and event fallback. */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { CyclesConfig } from "../src/config.js";
import {
  authFingerprint,
  CommitJournal,
  defaultJournalDir,
  type PendingCommitRecord,
} from "../src/journal.js";
import { AsyncCyclesLifecycle, buildEventFallbackBody } from "../src/lifecycle.js";
import { CyclesResponse } from "../src/response.js";
import { CommitRetryEngine } from "../src/retry.js";

const BASE_URL = "http://localhost";
const API_KEY = "test-key";

function makeConfig(
  overrides: Partial<ConstructorParameters<typeof CyclesConfig>[0]> = {},
): CyclesConfig {
  return new CyclesConfig({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    retryMaxAttempts: 3,
    retryInitialDelay: 100,
    retryMultiplier: 1,
    retryMaxDelay: 500,
    ...overrides,
  });
}

function commitBody(): Record<string, unknown> {
  return { idempotency_key: "ck-1", actual: { unit: "USD_MICROCENTS", amount: 100 } };
}

function eventBody(): Record<string, unknown> {
  return {
    idempotency_key: "ck-1",
    subject: { tenant: "acme" },
    action: { kind: "llm.completion", name: "gpt" },
    actual: { unit: "USD_MICROCENTS", amount: 100 },
  };
}

function record(
  reservationId = "rsv_1",
  overrides: Partial<PendingCommitRecord> = {},
): PendingCommitRecord {
  return {
    reservationId,
    baseUrl: BASE_URL,
    mode: "commit",
    commitBody: commitBody(),
    eventFallbackBody: eventBody(),
    recordedAtMs: 1,
    ...overrides,
  };
}

function identityDir(apiKey = API_KEY, baseUrl = BASE_URL, tenant?: string): string {
  return path.join(defaultJournalDir(), authFingerprint(baseUrl, apiKey, tenant));
}

function journalFiles(): string[] {
  const out: string[] = [];
  const base = defaultJournalDir();
  if (!fs.existsSync(base)) return out;
  for (const sub of fs.readdirSync(base)) {
    const dir = path.join(base, sub);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".json")) out.push(path.join(dir, name));
    }
  }
  return out.sort();
}

function expiredResponse(): CyclesResponse {
  return CyclesResponse.httpError(410, "Expired", {
    error: "RESERVATION_EXPIRED",
    message: "Expired",
    request_id: "r1",
  });
}

function commitSuccess(): CyclesResponse {
  return CyclesResponse.success(200, { status: "COMMITTED" });
}

function eventSuccess(): CyclesResponse {
  return CyclesResponse.success(201, { status: "APPLIED", event_id: "evt_1" });
}

interface MockClient {
  commitReservation: ReturnType<typeof vi.fn>;
  createEvent: ReturnType<typeof vi.fn>;
}

function makeMockClient(): MockClient {
  return { commitReservation: vi.fn(), createEvent: vi.fn() };
}

// ---------------------------------------------------------------------------
// CommitJournal
// ---------------------------------------------------------------------------

describe("CommitJournal", () => {
  it("records, loads, and discards a pending commit", () => {
    const journal = new CommitJournal(path.join(defaultJournalDir(), "j"));
    journal.record(record("rsv_a"));

    const loaded = journal.loadPending(BASE_URL);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].reservationId).toBe("rsv_a");
    expect(loaded[0].mode).toBe("commit");
    expect(loaded[0].commitBody).toEqual(commitBody());
    expect(loaded[0].eventFallbackBody).toEqual(eventBody());

    journal.discard("rsv_a");
    expect(journal.loadPending(BASE_URL)).toHaveLength(0);
  });

  it("overwrites a record for the same reservation", () => {
    const journal = new CommitJournal(path.join(defaultJournalDir(), "j"));
    journal.record(record("rsv_a"));
    journal.record(record("rsv_a", { mode: "event" }));
    const loaded = journal.loadPending(BASE_URL);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].mode).toBe("event");
  });

  it("filters by base URL", () => {
    const journal = new CommitJournal(path.join(defaultJournalDir(), "j"));
    journal.record(record("rsv_a"));
    journal.record(record("rsv_b", { baseUrl: "http://other:9999" }));
    const loaded = journal.loadPending(BASE_URL);
    expect(loaded.map((e) => e.reservationId)).toEqual(["rsv_a"]);
  });

  it("returns empty for a missing directory", () => {
    const journal = new CommitJournal(path.join(defaultJournalDir(), "missing"));
    expect(journal.loadPending(BASE_URL)).toEqual([]);
  });

  it("quarantines corrupt files as *.corrupt", () => {
    const dir = path.join(defaultJournalDir(), "j");
    const journal = new CommitJournal(dir);
    journal.record(record("rsv_good"));
    fs.writeFileSync(path.join(dir, "rsv_bad.json"), "{not json", "utf-8");

    const loaded = journal.loadPending(BASE_URL);
    expect(loaded.map((e) => e.reservationId)).toEqual(["rsv_good"]);
    expect(fs.existsSync(path.join(dir, "rsv_bad.corrupt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "rsv_bad.json"))).toBe(false);
  });

  it("quarantines semantically invalid records", () => {
    const dir = path.join(defaultJournalDir(), "j");
    fs.mkdirSync(dir, { recursive: true });
    const cases: Record<string, string> = {
      "no_rid.json": '{"reservation_id": "", "mode": "commit", "commit_body": {}}',
      "bad_mode.json": '{"reservation_id": "r1", "mode": "sideways", "commit_body": {}}',
      "commit_no_body.json": '{"reservation_id": "r2", "mode": "commit"}',
      "event_no_body.json": '{"reservation_id": "r3", "mode": "event", "commit_body": {}}',
    };
    for (const [name, content] of Object.entries(cases)) {
      fs.writeFileSync(path.join(dir, name), content, "utf-8");
    }

    const journal = new CommitJournal(dir);
    expect(journal.loadPending(BASE_URL)).toEqual([]);
    const corrupt = fs.readdirSync(dir).filter((n) => n.endsWith(".corrupt"));
    expect(corrupt).toHaveLength(Object.keys(cases).length);
  });

  it("record never throws when the directory cannot be created", () => {
    // A file where the directory should be forces mkdirSync to fail.
    const blocker = path.join(defaultJournalDir(), "blocked");
    fs.mkdirSync(defaultJournalDir(), { recursive: true });
    fs.writeFileSync(blocker, "file", "utf-8");
    const journal = new CommitJournal(blocker);
    expect(() => journal.record(record("rsv_a"))).not.toThrow();
    expect(journal.loadPending(BASE_URL)).toEqual([]);
  });

  it("ignores stale temp files from crashed writers", () => {
    const dir = path.join(defaultJournalDir(), "j");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rsv_x.json.999.deadbeef.tmp"), "{partial", "utf-8");

    const journal = new CommitJournal(dir);
    journal.record(record("rsv_a"));
    expect(journal.loadPending(BASE_URL).map((e) => e.reservationId)).toEqual(["rsv_a"]);
  });

  it("preserves the notBeforeMs floor across a write/read roundtrip", () => {
    const journal = new CommitJournal(path.join(defaultJournalDir(), "j"));
    journal.record(record("rsv_a", { notBeforeMs: 12345 }));
    expect(journal.loadPending(BASE_URL)[0].notBeforeMs).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// authFingerprint
// ---------------------------------------------------------------------------

describe("authFingerprint", () => {
  it("is stable and identity-scoped", () => {
    const fp = authFingerprint(BASE_URL, API_KEY);
    expect(fp).toBe(authFingerprint(BASE_URL, API_KEY));
    expect(fp).toHaveLength(16);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toBe(authFingerprint(BASE_URL, "other-key"));
    expect(fp).not.toBe(authFingerprint("http://other:9999", API_KEY));
  });

  it("uses the tenant as a rotation-safe principal", () => {
    const fp = authFingerprint(BASE_URL, API_KEY, "acme");
    expect(fp).toBe(authFingerprint(BASE_URL, "rotated-key", "acme"));
    expect(fp).not.toBe(authFingerprint(BASE_URL, API_KEY, "globex"));
    expect(fp).not.toBe(authFingerprint(BASE_URL, API_KEY));
  });

  it("is byte-compatible with the Python SDK derivation", () => {
    // Vectors computed with Python hashlib.pbkdf2_hmac — same-tenant
    // Python and TypeScript clients must share an identity directory.
    expect(authFingerprint("http://localhost", "test-key")).toBe("68c905017df7dbfc");
    expect(authFingerprint("http://localhost", "any-key", "acme")).toBe("8baba538fb970da4");
  });
});

// ---------------------------------------------------------------------------
// buildEventFallbackBody
// ---------------------------------------------------------------------------

describe("buildEventFallbackBody", () => {
  it("builds the spec shape reusing the commit idempotency key", () => {
    const body = buildEventFallbackBody(
      "rsv_9",
      { tenant: "acme" },
      { kind: "llm.completion", name: "gpt" },
      {
        idempotency_key: "ck-9",
        actual: { unit: "USD_MICROCENTS", amount: 250 },
        metrics: { latency_ms: 12 },
        metadata: { run: "abc" },
      },
    );

    expect(body.idempotency_key).toBe("ck-9");
    expect(body.subject).toEqual({ tenant: "acme" });
    expect(body.action).toEqual({ kind: "llm.completion", name: "gpt" });
    expect(body.actual).toEqual({ unit: "USD_MICROCENTS", amount: 250 });
    expect(body.metrics).toEqual({ latency_ms: 12 });
    const metadata = body.metadata as Record<string, unknown>;
    expect(metadata.run).toBe("abc");
    expect(metadata.recovered_reservation_id).toBe("rsv_9");
    expect(metadata.recovery_reason).toBe("commit_after_reservation_expired");
    expect("overage_policy" in body).toBe(false);
  });

  it("omits metrics when absent and still adds recovery markers", () => {
    const body = buildEventFallbackBody("rsv_9", { tenant: "acme" }, { kind: "k", name: "n" }, commitBody());
    expect("metrics" in body).toBe(false);
    const metadata = body.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      "recovered_reservation_id",
      "recovery_reason",
    ]);
  });
});

// ---------------------------------------------------------------------------
// CommitRetryEngine durability (fake timers)
// ---------------------------------------------------------------------------

describe("CommitRetryEngine durability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("journals on schedule and discards on success", async () => {
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(commitSuccess());
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody(), eventBody());
    expect(journalFiles()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(client.commitReservation).toHaveBeenCalledTimes(1);
    expect(journalFiles()).toHaveLength(0);
  });

  it("falls back to POST /v1/events when the reservation expired", async () => {
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(expiredResponse());
    client.createEvent.mockResolvedValue(eventSuccess());
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody(), eventBody());
    await vi.advanceTimersByTimeAsync(100);

    expect(client.commitReservation).toHaveBeenCalledTimes(1);
    expect(client.createEvent).toHaveBeenCalledWith(eventBody());
    expect(journalFiles()).toHaveLength(0);
  });

  it("retains the journal when expired with no event fallback", async () => {
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(expiredResponse());
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody());
    await vi.advanceTimersByTimeAsync(100);

    expect(client.createEvent).not.toHaveBeenCalled();
    expect(journalFiles()).toHaveLength(1);
  });

  it("discards the journal on a genuine rejection", async () => {
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(409, "Finalized", {
        error: "RESERVATION_FINALIZED",
        message: "Finalized",
        request_id: "r2",
      }),
    );
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody(), eventBody());
    await vi.advanceTimersByTimeAsync(100);

    expect(journalFiles()).toHaveLength(0);
  });

  it("retains the journal when retries exhaust", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(CyclesResponse.httpError(500, "boom"));
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody(), eventBody());
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(client.commitReservation).toHaveBeenCalledTimes(3);
    expect(journalFiles()).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("retained"));
  });

  it("scheduleEvent posts the event directly", async () => {
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.createEvent.mockResolvedValue(eventSuccess());
    engine.setClient(client as never);

    engine.scheduleEvent("rsv_1", eventBody());
    await vi.advanceTimersByTimeAsync(100);

    expect(client.createEvent).toHaveBeenCalledWith(eventBody());
    expect(client.commitReservation).not.toHaveBeenCalled();
    expect(journalFiles()).toHaveLength(0);
  });

  it("treats 429 as transient, honors Retry-After, and persists the floor", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation
      .mockResolvedValueOnce(
        CyclesResponse.httpError(429, "busy", { error: "LIMIT_EXCEEDED", message: "m", request_id: "r" }, { "retry-after": "2" }),
      )
      .mockResolvedValueOnce(commitSuccess());
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody(), eventBody());
    await vi.advanceTimersByTimeAsync(100);
    expect(client.commitReservation).toHaveBeenCalledTimes(1);

    // Floor persisted as an absolute timestamp for restart survival.
    const files = journalFiles();
    expect(files).toHaveLength(1);
    const rec = JSON.parse(fs.readFileSync(files[0], "utf-8"));
    expect(rec.not_before_ms).toBeGreaterThan(Date.now());

    // Next attempt waits the server's 2s, not the 100ms backoff.
    await vi.advanceTimersByTimeAsync(100);
    expect(client.commitReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(client.commitReservation).toHaveBeenCalledTimes(2);
    expect(journalFiles()).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("retains the journal on authentication failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(CyclesResponse.httpError(401, "Unauthorized"));
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody(), eventBody());
    await vi.advanceTimersByTimeAsync(100);

    // Terminal for this run, but the durable record survives for replay
    // once credentials are fixed.
    expect(client.commitReservation).toHaveBeenCalledTimes(1);
    expect(journalFiles()).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("authentication failure"));
  });

  it("schedule seeds the Retry-After floor from a rate-limited first attempt", async () => {
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(commitSuccess());
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody(), eventBody(), 2_000);

    // The 100ms backoff is superseded by the server's 2s floor.
    await vi.advanceTimersByTimeAsync(100);
    expect(client.commitReservation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_900);
    expect(client.commitReservation).toHaveBeenCalledTimes(1);
  });

  it("event fallback treats 429 as transient and retains on exhaustion", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.createEvent.mockResolvedValue(
      CyclesResponse.httpError(429, "busy", { error: "LIMIT_EXCEEDED", message: "m", request_id: "r" }),
    );
    engine.setClient(client as never);

    engine.scheduleEvent("rsv_1", eventBody());
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(client.createEvent).toHaveBeenCalledTimes(3);
    expect(journalFiles()).toHaveLength(1);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("event fallback retains the journal on authentication failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.createEvent.mockResolvedValue(CyclesResponse.httpError(403, "Forbidden"));
    engine.setClient(client as never);

    engine.scheduleEvent("rsv_1", eventBody());
    await vi.advanceTimersByTimeAsync(100);

    expect(client.createEvent).toHaveBeenCalledTimes(1);
    expect(journalFiles()).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it("event fallback discards the journal on a genuine rejection", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.createEvent.mockResolvedValue(
      CyclesResponse.httpError(409, "Mismatch", {
        error: "IDEMPOTENCY_MISMATCH",
        message: "m",
        request_id: "r",
      }),
    );
    engine.setClient(client as never);

    engine.scheduleEvent("rsv_1", eventBody());
    await vi.advanceTimersByTimeAsync(100);

    expect(client.createEvent).toHaveBeenCalledTimes(1);
    expect(journalFiles()).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it("bails out when no client is set", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig({ journalEnabled: false }));
    engine.schedule("rsv_1", commitBody());
    await vi.advanceTimersByTimeAsync(100);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No client set"));
    errorSpy.mockRestore();
  });

  it("journals without retrying when retry is disabled", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig({ retryEnabled: false }));
    const client = makeMockClient();
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody());

    expect(client.commitReservation).not.toHaveBeenCalled();
    expect(journalFiles()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("journaled for replay"));
    warnSpy.mockRestore();
  });

  it("drops with a warning when retry and journal are both disabled", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig({ retryEnabled: false, journalEnabled: false }));
    engine.setClient(makeMockClient() as never);

    engine.schedule("rsv_1", commitBody());

    expect(journalFiles()).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dropping"));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Journal replay
// ---------------------------------------------------------------------------

describe("journal replay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("replays pending commits when the first engine appears", async () => {
    new CommitJournal(identityDir()).record(record("rsv_old"));

    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(commitSuccess());
    engine.setClient(client as never);
    await vi.advanceTimersByTimeAsync(100);

    expect(client.commitReservation).toHaveBeenCalledWith("rsv_old", commitBody());
    expect(journalFiles()).toHaveLength(0);
  });

  it("replays event-mode entries via createEvent", async () => {
    new CommitJournal(identityDir()).record(
      record("rsv_old", { mode: "event", commitBody: undefined }),
    );

    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.createEvent.mockResolvedValue(eventSuccess());
    engine.setClient(client as never);
    await vi.advanceTimersByTimeAsync(100);

    expect(client.createEvent).toHaveBeenCalledWith(eventBody());
    expect(journalFiles()).toHaveLength(0);
  });

  it("claims replay once per identity directory", async () => {
    new CommitJournal(identityDir()).record(record("rsv_old"));
    const config = makeConfig();

    const first = new CommitRetryEngine(config);
    const client1 = makeMockClient();
    client1.commitReservation.mockResolvedValue(commitSuccess());
    first.setClient(client1 as never);
    await vi.advanceTimersByTimeAsync(100);

    const second = new CommitRetryEngine(config);
    const client2 = makeMockClient();
    second.setClient(client2 as never);
    await vi.advanceTimersByTimeAsync(100);

    expect(client1.commitReservation).toHaveBeenCalledTimes(1);
    expect(client2.commitReservation).not.toHaveBeenCalled();
  });

  it("isolates replay by credential identity", async () => {
    new CommitJournal(identityDir(API_KEY)).record(record("rsv_a"));
    new CommitJournal(identityDir("other-key")).record(record("rsv_b"));

    const engineA = new CommitRetryEngine(makeConfig());
    const clientA = makeMockClient();
    clientA.commitReservation.mockResolvedValue(commitSuccess());
    engineA.setClient(clientA as never);
    await vi.advanceTimersByTimeAsync(100);

    expect(clientA.commitReservation).toHaveBeenCalledTimes(1);
    expect(clientA.commitReservation).toHaveBeenCalledWith("rsv_a", commitBody());
    expect(journalFiles()).toHaveLength(1); // rsv_b untouched

    const engineB = new CommitRetryEngine(makeConfig({ apiKey: "other-key" }));
    const clientB = makeMockClient();
    clientB.commitReservation.mockResolvedValue(commitSuccess());
    engineB.setClient(clientB as never);
    await vi.advanceTimersByTimeAsync(100);

    expect(clientB.commitReservation).toHaveBeenCalledWith("rsv_b", commitBody());
    expect(journalFiles()).toHaveLength(0);
  });

  it("survives API-key rotation when a tenant is configured", async () => {
    new CommitJournal(identityDir("old-key", BASE_URL, "acme")).record(record("rsv_old"));

    const engine = new CommitRetryEngine(makeConfig({ apiKey: "rotated-key", tenant: "acme" }));
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(commitSuccess());
    engine.setClient(client as never);
    await vi.advanceTimersByTimeAsync(100);

    expect(client.commitReservation).toHaveBeenCalledWith("rsv_old", commitBody());
    expect(journalFiles()).toHaveLength(0);
  });

  it("restores a future Retry-After floor and ignores a past one", async () => {
    new CommitJournal(identityDir()).record(
      record("rsv_future", { notBeforeMs: Date.now() + 5_000 }),
    );
    new CommitJournal(identityDir()).record(
      record("rsv_past", { notBeforeMs: Date.now() - 1_000 }),
    );

    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(commitSuccess());
    engine.setClient(client as never);

    // Past floor → normal 100ms backoff fires first.
    await vi.advanceTimersByTimeAsync(100);
    expect(client.commitReservation).toHaveBeenCalledTimes(1);
    expect(client.commitReservation).toHaveBeenCalledWith("rsv_past", commitBody());

    // Future floor → waits ~5s despite the 100ms backoff.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(client.commitReservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.commitReservation).toHaveBeenCalledTimes(2);
  });

  it("does not replay when retry is disabled", () => {
    new CommitJournal(identityDir()).record(record("rsv_old"));
    const engine = new CommitRetryEngine(makeConfig({ retryEnabled: false }));
    const client = makeMockClient();
    engine.setClient(client as never);
    expect(client.commitReservation).not.toHaveBeenCalled();
    expect(journalFiles()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Engine flush
// ---------------------------------------------------------------------------

describe("engine flush", () => {
  it("waits for in-flight retries and returns immediately with zero timeout", async () => {
    const engine = new CommitRetryEngine(
      makeConfig({ retryInitialDelay: 10, retryFlushTimeout: 0 }),
    );
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(commitSuccess());
    engine.setClient(client as never);

    await engine.flush(); // zero timeout → immediate, no pending work either way

    engine.schedule("rsv_1", commitBody());
    await engine.flush(1_000);
    expect(client.commitReservation).toHaveBeenCalledTimes(1);
    expect(journalFiles()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle wiring: first-attempt 429/401/expired handling
// ---------------------------------------------------------------------------

describe("lifecycle commit wiring", () => {
  function allowResponse(): CyclesResponse {
    return CyclesResponse.success(200, {
      decision: "ALLOW",
      reservation_id: "rsv_test",
      expires_at_ms: Date.now() + 600_000,
      affected_scopes: ["tenant:acme"],
      scope_path: "tenant:acme",
      reserved: { unit: "USD_MICROCENTS", amount: 1000 },
    });
  }

  function makeLifecycle() {
    const client = {
      createReservation: vi.fn(),
      commitReservation: vi.fn(),
      releaseReservation: vi.fn(),
      extendReservation: vi.fn(),
      createEvent: vi.fn(),
    };
    const engine = {
      setClient: vi.fn(),
      schedule: vi.fn(),
      scheduleEvent: vi.fn(),
    };
    const lifecycle = new AsyncCyclesLifecycle(
      client as never,
      engine as never,
      { tenant: "acme" },
    );
    return { lifecycle, client, engine };
  }

  const cfg = { estimate: 1000, tenant: "acme", ttlMs: 60_000 };

  it("schedules retry with Retry-After on a rate-limited first commit", async () => {
    const { lifecycle, client, engine } = makeLifecycle();
    client.createReservation.mockResolvedValue(allowResponse());
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(429, "busy", { error: "LIMIT_EXCEEDED", message: "m", request_id: "r" }, { "retry-after": "3" }),
    );

    await lifecycle.execute(async () => "result", [], cfg);

    expect(engine.schedule).toHaveBeenCalledTimes(1);
    expect(engine.schedule.mock.calls[0][0]).toBe("rsv_test");
    expect(engine.schedule.mock.calls[0][3]).toBe(3_000);
    expect(client.releaseReservation).not.toHaveBeenCalled();
  });

  it("journals instead of releasing on a first-attempt auth failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { lifecycle, client, engine } = makeLifecycle();
    client.createReservation.mockResolvedValue(allowResponse());
    client.commitReservation.mockResolvedValue(CyclesResponse.httpError(401, "Unauthorized"));

    await lifecycle.execute(async () => "result", [], cfg);

    expect(engine.schedule).toHaveBeenCalledTimes(1);
    expect(client.releaseReservation).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("recovers spend via scheduleEvent on an expired first commit", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { lifecycle, client, engine } = makeLifecycle();
    client.createReservation.mockResolvedValue(allowResponse());
    client.commitReservation.mockResolvedValue(expiredResponse());

    await lifecycle.execute(async () => "result", [], cfg);

    expect(engine.scheduleEvent).toHaveBeenCalledTimes(1);
    const [rid, body] = engine.scheduleEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(rid).toBe("rsv_test");
    expect((body.metadata as Record<string, unknown>).recovered_reservation_id).toBe("rsv_test");
    expect(body.subject).toEqual({ tenant: "acme" });
    expect(client.releaseReservation).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("passes the event fallback on transient commit failures", async () => {
    const { lifecycle, client, engine } = makeLifecycle();
    client.createReservation.mockResolvedValue(allowResponse());
    client.commitReservation.mockResolvedValue(CyclesResponse.httpError(500, "boom"));

    await lifecycle.execute(async () => "result", [], cfg);

    expect(engine.schedule).toHaveBeenCalledTimes(1);
    const fallback = engine.schedule.mock.calls[0][2] as Record<string, unknown>;
    expect((fallback.metadata as Record<string, unknown>).recovered_reservation_id).toBe("rsv_test");
  });

  it("still releases on a genuine rejection", async () => {
    const { lifecycle, client, engine } = makeLifecycle();
    client.createReservation.mockResolvedValue(allowResponse());
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(409, "Unit mismatch", {
        error: "UNIT_MISMATCH",
        message: "m",
        request_id: "r",
      }),
    );
    client.releaseReservation.mockResolvedValue(CyclesResponse.success(200, { status: "RELEASED" }));

    await lifecycle.execute(async () => "result", [], cfg);

    expect(engine.schedule).not.toHaveBeenCalled();
    expect(engine.scheduleEvent).not.toHaveBeenCalled();
    expect(client.releaseReservation).toHaveBeenCalledTimes(1);
  });
});
