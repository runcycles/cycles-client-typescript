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
import {
  _resetReplayStateForTests,
  CommitRetryEngine,
} from "../src/retry.js";
import {
  isSchemaValidCommitSuccess,
  isSchemaValidEventSuccess,
} from "../src/settlement.js";
// Imported from the package barrel on purpose: guards the public export.
import { flushPendingCommits } from "../src/index.js";

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
  return CyclesResponse.success(200, {
    status: "COMMITTED",
    charged: { unit: "USD_MICROCENTS", amount: 100 },
  });
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

  it("uses cross-SDK digest names and safely migrates colliding legacy names", () => {
    const dir = path.join(defaultJournalDir(), "j");
    const journal = new CommitJournal(dir);
    journal.record(record("rsv/a"));
    journal.record(record("rsv_a"));
    expect(fs.readdirSync(dir).sort()).toEqual([
      "v2-80bbb4b84643293ad96bc2381b863301591d0acc7afb0858cd7bcdee5f698099.json",
      "v2-e3edb9ca022de3c9c90c5667d47fa66448cee1f254e488a761313faee34141d7.json",
    ]);

    const legacy = path.join(dir, "rsv_a.json");
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        version: 1,
        reservation_id: "rsv/a",
        base_url: BASE_URL,
        mode: "commit",
        commit_body: commitBody(),
        event_fallback_body: eventBody(),
        recorded_at_ms: 1,
        not_before_ms: null,
      }),
      "utf-8",
    );
    journal.discard("rsv_a");
    expect(fs.existsSync(legacy)).toBe(true);
    const loaded = journal.loadPending(BASE_URL);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(loaded.map((entry) => entry.reservationId)).toEqual(["rsv/a"]);
  });

  it("uses the standard UTF-8 digest for non-BMP identifiers", () => {
    const dir = path.join(defaultJournalDir(), "j");
    new CommitJournal(dir).record(record("r🚀"));
    expect(fs.readdirSync(dir)).toEqual([
      "v2-34c5b33347a139e63c81ea72943cc15dd4c2087dc1eaa756a78f3c49974e0b87.json",
    ]);
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

  it("quarantines corrupt and unsupported records without blocking valid replay", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = path.join(defaultJournalDir(), "j");
    const journal = new CommitJournal(dir);
    journal.record(record("rsv_good"));
    fs.writeFileSync(path.join(dir, "rsv_bad.json"), "{not json", "utf-8");
    fs.writeFileSync(
      path.join(dir, "rsv_future.json"),
      JSON.stringify({
        version: 2,
        reservation_id: "rsv_future",
        base_url: BASE_URL,
        mode: "commit",
        commit_body: commitBody(),
        recorded_at_ms: 1,
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(dir, "rsv_array.json"), "[]", "utf-8");

    const loaded = journal.loadPending(BASE_URL);
    expect(loaded.map((e) => e.reservationId)).toEqual(["rsv_good"]);
    for (const stem of ["rsv_bad", "rsv_future", "rsv_array"]) {
      expect(fs.existsSync(path.join(dir, `${stem}.corrupt`))).toBe(true);
      expect(fs.existsSync(path.join(dir, `${stem}.json`))).toBe(false);
    }
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("rsv_future.json"));
    warnSpy.mockRestore();
  });

  it("quarantines semantically invalid records", () => {
    const dir = path.join(defaultJournalDir(), "j");
    fs.mkdirSync(dir, { recursive: true });
    const cases: Record<string, string> = {
      "no_rid.json":
        '{"version": 1, "reservation_id": "", "mode": "commit", "commit_body": {}}',
      "bad_mode.json":
        '{"version": 1, "reservation_id": "r1", "mode": "sideways", "commit_body": {}}',
      "commit_no_body.json":
        '{"version": 1, "reservation_id": "r2", "mode": "commit"}',
      "event_no_body.json":
        '{"version": 1, "reservation_id": "r3", "mode": "event", "commit_body": {}}',
      "bad_timestamp.json":
        '{"version": 1, "reservation_id": "r4", "mode": "commit", "commit_body": {}, "recorded_at_ms": "now"}',
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

  it("quarantines records with an explicit null mode", () => {
    // `mode: null` must not coerce to "commit" — Python/Java reject it.
    const dir = path.join(defaultJournalDir(), "j");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "null_mode.json"),
      '{"version": 1, "reservation_id": "r1", "mode": null, "commit_body": {}}',
      "utf-8",
    );
    const journal = new CommitJournal(dir);
    expect(journal.loadPending(BASE_URL)).toEqual([]);
    expect(fs.existsSync(path.join(dir, "null_mode.corrupt"))).toBe(true);
  });

  it("quarantines records with array-valued bodies", () => {
    // typeof [] === "object" — arrays must still be rejected.
    const dir = path.join(defaultJournalDir(), "j");
    fs.mkdirSync(dir, { recursive: true });
    const cases: Record<string, string> = {
      "array_commit.json":
        '{"version": 1, "reservation_id": "r1", "mode": "commit", "commit_body": []}',
      "array_event.json":
        '{"version": 1, "reservation_id": "r2", "mode": "event", "commit_body": {}, "event_fallback_body": []}',
    };
    for (const [name, content] of Object.entries(cases)) {
      fs.writeFileSync(path.join(dir, name), content, "utf-8");
    }
    const journal = new CommitJournal(dir);
    expect(journal.loadPending(BASE_URL)).toEqual([]);
    const corrupt = fs.readdirSync(dir).filter((n) => n.endsWith(".corrupt"));
    expect(corrupt).toHaveLength(2);
  });

  it("garbage-collects stale temp files on load and keeps fresh ones", () => {
    const dir = path.join(defaultJournalDir(), "j");
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, "rsv_x.json.111.aaaa.tmp");
    const fresh = path.join(dir, "rsv_y.json.222.bbbb.tmp");
    fs.writeFileSync(stale, "{partial", "utf-8");
    fs.writeFileSync(fresh, "{partial", "utf-8");
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);

    new CommitJournal(dir).loadPending(BASE_URL);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  // POSIX-only: Windows has no meaningful directory mode bits.
  it.skipIf(process.platform === "win32")(
    "tightens permissions on both the identity and base directories",
    () => {
      const dir = path.join(defaultJournalDir(), "j");
      new CommitJournal(dir).record(record("rsv_a"));
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.dirname(dir)).mode & 0o777).toBe(0o700);
    },
  );
});

describe("strict settlement success validation", () => {
  it("accepts commit evidence and rejects invalid optional values and units", () => {
    const body = {
      status: "COMMITTED",
      charged: { unit: "USD_MICROCENTS", amount: 1 },
      cycles_evidence: {
        evidence_id: "a".repeat(64),
        cycles_evidence_url: "https://cycles.example/v1/evidence/id",
      },
    };
    expect(
      isSchemaValidCommitSuccess(CyclesResponse.success(200, body)),
    ).toBe(true);
    expect(
      isSchemaValidCommitSuccess(
        CyclesResponse.success(200, { ...body, balances: null }),
      ),
    ).toBe(false);
    expect(
      isSchemaValidCommitSuccess(
        CyclesResponse.success(200, {
          ...body,
          charged: { unit: "FUTURE_UNIT", amount: 1 },
        }),
      ),
    ).toBe(false);
  });

  it("follows the event response wire schema exactly", () => {
    expect(
      isSchemaValidEventSuccess(
        CyclesResponse.success(201, { status: "APPLIED", event_id: "" }),
      ),
    ).toBe(true);
    expect(
      isSchemaValidEventSuccess(
        CyclesResponse.success(201, {
          status: "APPLIED",
          event_id: "event-1",
          charged: null,
        }),
      ),
    ).toBe(false);
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

  it("treats a blank tenant as absent but keeps the raw value when present", () => {
    // Presence check trims; the principal itself stays untrimmed
    // (matches the Python/Java SDKs exactly).
    const keyBased = authFingerprint(BASE_URL, API_KEY);
    expect(authFingerprint(BASE_URL, API_KEY, "")).toBe(keyBased);
    expect(authFingerprint(BASE_URL, API_KEY, "   ")).toBe(keyBased);
    expect(authFingerprint(BASE_URL, API_KEY, " acme ")).not.toBe(keyBased);
    expect(authFingerprint(BASE_URL, API_KEY, " acme ")).not.toBe(
      authFingerprint(BASE_URL, API_KEY, "acme"),
    );
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
    client.createEvent.mockImplementation(async () => {
      const persisted = new CommitJournal(identityDir()).loadPending(BASE_URL);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].mode).toBe("event");
      expect(persisted[0].eventFallbackBody).toEqual(eventBody());
      return eventSuccess();
    });
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

  it("treats a bodyless 410 as expired and falls back to events", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(CyclesResponse.httpError(410, "Gone"));
    client.createEvent.mockResolvedValue(eventSuccess());
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody(), eventBody());
    await vi.advanceTimersByTimeAsync(100);

    expect(client.createEvent).toHaveBeenCalledWith(eventBody());
    expect(journalFiles()).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("retains the journal when expired with an empty event fallback", async () => {
    // An empty fallback body carries no spend information — retaining the
    // journal matches the Python/Java SDKs.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(expiredResponse());
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody(), {});
    await vi.advanceTimersByTimeAsync(100);

    expect(client.createEvent).not.toHaveBeenCalled();
    expect(journalFiles()).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("no event fallback"));
    errorSpy.mockRestore();
  });

  it("retains the journal on a 4xx with an unrecognized error code", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(400, "weird", {
        error: "SOME_FUTURE_CODE",
        message: "m",
        request_id: "r",
      }),
    );
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody(), eventBody());
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    // Terminal for this run (no second attempt) but the record survives.
    expect(client.commitReservation).toHaveBeenCalledTimes(1);
    expect(journalFiles()).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unclassifiable"));
    errorSpy.mockRestore();
  });

  it("retains the journal on a codeless 4xx", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(CyclesResponse.httpError(400, "Bad request"));
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody(), eventBody());
    await vi.advanceTimersByTimeAsync(100);

    expect(client.commitReservation).toHaveBeenCalledTimes(1);
    expect(journalFiles()).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it("event fallback retries on a 5xx and succeeds", async () => {
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.createEvent
      .mockResolvedValueOnce(CyclesResponse.httpError(500, "boom"))
      .mockResolvedValueOnce(eventSuccess());
    engine.setClient(client as never);

    engine.scheduleEvent("rsv_1", eventBody());
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(client.createEvent).toHaveBeenCalledTimes(2);
    expect(journalFiles()).toHaveLength(0);
  });

  it("event fallback retains the journal on an unrecognized 4xx code", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.createEvent.mockResolvedValue(
      CyclesResponse.httpError(400, "weird", {
        error: "SOME_FUTURE_CODE",
        message: "m",
        request_id: "r",
      }),
    );
    engine.setClient(client as never);

    engine.scheduleEvent("rsv_1", eventBody());
    await vi.advanceTimersByTimeAsync(100);

    expect(client.createEvent).toHaveBeenCalledTimes(1);
    expect(journalFiles()).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unclassifiable"));
    errorSpy.mockRestore();
  });

  it("clamps a scheduled Retry-After to one hour", async () => {
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(commitSuccess());
    engine.setClient(client as never);

    // 24h requested — must be honored for at most 1h.
    engine.schedule("rsv_1", commitBody(), eventBody(), 86_400_000);

    const files = journalFiles();
    expect(files).toHaveLength(1);
    const rec = JSON.parse(fs.readFileSync(files[0], "utf-8"));
    expect(rec.not_before_ms).toBeLessThanOrEqual(Date.now() + 3_600_000);

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(client.commitReservation).toHaveBeenCalledTimes(1);
  });

  it("clamps a 429 Retry-After header to one hour", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation
      .mockResolvedValueOnce(
        CyclesResponse.httpError(
          429,
          "busy",
          { error: "LIMIT_EXCEEDED", message: "m", request_id: "r" },
          { "retry-after": "86400" }, // 24h in seconds
        ),
      )
      .mockResolvedValueOnce(commitSuccess());
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody(), eventBody());
    await vi.advanceTimersByTimeAsync(100);
    expect(client.commitReservation).toHaveBeenCalledTimes(1);

    const rec = JSON.parse(fs.readFileSync(journalFiles()[0], "utf-8"));
    expect(rec.not_before_ms).toBeLessThanOrEqual(Date.now() + 3_600_000);

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(client.commitReservation).toHaveBeenCalledTimes(2);
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
    const oldIdentityDir = identityDir("old-key", BASE_URL, "acme");
    new CommitJournal(oldIdentityDir).record(record("rsv_old"));
    const persisted = path.join(oldIdentityDir, fs.readdirSync(oldIdentityDir)[0]);
    expect(persisted).not.toContain("old-key");
    expect(fs.readFileSync(persisted, "utf-8")).not.toContain("old-key");

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
    expect(journalFiles()).toHaveLength(0);
  });

  it("concurrent replay workers reuse one key and remove the record", async () => {
    new CommitJournal(identityDir()).record(record("rsv_old"));
    const seenKeys: string[] = [];
    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const client = makeMockClient();
    client.commitReservation.mockImplementation(
      async (_reservationId: string, body: Record<string, unknown>) => {
        seenKeys.push(String(body.idempotency_key));
        if (seenKeys.length === 2) releaseBoth();
        await bothArrived;
        return commitSuccess();
      },
    );

    const first = new CommitRetryEngine(makeConfig());
    first.setClient(client as never);
    await vi.advanceTimersByTimeAsync(100);
    expect(client.commitReservation).toHaveBeenCalledTimes(1);

    // Model a separate process: the second worker carries no in-memory
    // replay claim, only the still-present durable record.
    _resetReplayStateForTests();
    const second = new CommitRetryEngine(makeConfig());
    second.setClient(client as never);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first.flush(1_000), second.flush(1_000)]);

    expect(seenKeys).toEqual(["ck-1", "ck-1"]);
    expect(new Set(seenKeys).size).toBe(1);
    expect(journalFiles()).toHaveLength(0);
  });

  it("does not replay when retry is disabled", () => {
    new CommitJournal(identityDir()).record(record("rsv_old"));
    const engine = new CommitRetryEngine(makeConfig({ retryEnabled: false }));
    const client = makeMockClient();
    engine.setClient(client as never);
    expect(client.commitReservation).not.toHaveBeenCalled();
    expect(journalFiles()).toHaveLength(1);
  });

  it("clamps a restored Retry-After floor to one hour", async () => {
    // A corrupted (or far-future) not_before_ms must not park the replay
    // for days — nor overflow Node's 2^31-1 setTimeout limit.
    new CommitJournal(identityDir()).record(
      record("rsv_far", { notBeforeMs: Date.now() + 30 * 86_400_000 }),
    );

    const engine = new CommitRetryEngine(makeConfig());
    const client = makeMockClient();
    client.commitReservation.mockResolvedValue(commitSuccess());
    engine.setClient(client as never);

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(client.commitReservation).toHaveBeenCalledTimes(1);
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

  it("clears the timeout timer once pending work settles", async () => {
    vi.useFakeTimers();
    try {
      const engine = new CommitRetryEngine(makeConfig({ retryInitialDelay: 10 }));
      const client = makeMockClient();
      client.commitReservation.mockResolvedValue(commitSuccess());
      engine.setClient(client as never);

      engine.schedule("rsv_1", commitBody());
      const flushed = engine.flush(60_000);
      await vi.advanceTimersByTimeAsync(10);
      await flushed;

      // The 60s race timer must not linger after the work settled.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// flushPendingCommits — process-wide flush across all registered engines
// ---------------------------------------------------------------------------

describe("flushPendingCommits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves immediately when no engines are registered", async () => {
    vi.useRealTimers();
    await expect(flushPendingCommits()).resolves.toBeUndefined();
  });

  it("flushes every registered engine under one deadline", async () => {
    // Engines live in closures inside withCycles/reserveForStream — the
    // registry is the only public path to them.
    const engineA = new CommitRetryEngine(makeConfig({ retryInitialDelay: 10 }));
    const engineB = new CommitRetryEngine(
      makeConfig({ apiKey: "other-key", retryInitialDelay: 20 }),
    );
    const clientA = makeMockClient();
    const clientB = makeMockClient();
    clientA.commitReservation.mockResolvedValue(commitSuccess());
    clientB.commitReservation.mockResolvedValue(commitSuccess());
    engineA.setClient(clientA as never);
    engineB.setClient(clientB as never);

    engineA.schedule("rsv_a", commitBody(), eventBody());
    engineB.schedule("rsv_b", commitBody(), eventBody());

    const flushed = flushPendingCommits(5_000);
    await vi.advanceTimersByTimeAsync(20);
    await flushed;

    expect(clientA.commitReservation).toHaveBeenCalledTimes(1);
    expect(clientB.commitReservation).toHaveBeenCalledTimes(1);
    expect(journalFiles()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defaults the deadline to the maximum engine flush timeout", async () => {
    const engine = new CommitRetryEngine(
      makeConfig({ retryInitialDelay: 10, retryFlushTimeout: 50 }),
    );
    const client = makeMockClient();
    // Commit hangs forever — only the deadline can end the flush.
    client.commitReservation.mockReturnValue(new Promise(() => {}));
    engine.setClient(client as never);

    engine.schedule("rsv_1", commitBody(), eventBody());

    const flushed = flushPendingCommits();
    await vi.advanceTimersByTimeAsync(60);
    await flushed;

    // Bounded by the engine's 50ms flush timeout; the record stays
    // journaled for next-run replay.
    expect(journalFiles()).toHaveLength(1);
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
      config: new CyclesConfig({ baseUrl: BASE_URL, apiKey: "key" }),
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
      persistPending: vi.fn(),
      discardPending: vi.fn(),
    };
    const lifecycle = new AsyncCyclesLifecycle(
      client as never,
      engine as never,
      { tenant: "acme" },
    );
    return { lifecycle, client, engine };
  }

  const cfg = { estimate: 1000, tenant: "acme", ttlMs: 60_000 };

  it("journals before the first commit request and discards valid success", async () => {
    const { lifecycle, client, engine } = makeLifecycle();
    client.createReservation.mockResolvedValue(allowResponse());
    client.commitReservation.mockResolvedValue(commitSuccess());
    const order: string[] = [];
    engine.persistPending.mockImplementation(() => order.push("persist"));
    client.commitReservation.mockImplementation(async () => {
      order.push("commit");
      return commitSuccess();
    });

    await lifecycle.execute(async () => "result", [], cfg);

    expect(order).toEqual(["persist", "commit"]);
    expect(engine.discardPending).toHaveBeenCalledWith("rsv_test");
  });

  it("treats a protocol-invalid 2xx as ambiguous and preserves the key", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { lifecycle, client, engine } = makeLifecycle();
    client.createReservation.mockResolvedValue(allowResponse());
    client.commitReservation.mockResolvedValue(
      CyclesResponse.success(200, { status: "COMMITTED" }),
    );

    await lifecycle.execute(async () => "result", [], cfg);

    expect(engine.schedule).toHaveBeenCalledTimes(1);
    const persisted = engine.persistPending.mock.calls[0][1] as Record<string, unknown>;
    const scheduled = engine.schedule.mock.calls[0][1] as Record<string, unknown>;
    expect(scheduled.idempotency_key).toBe(persisted.idempotency_key);
    expect(engine.discardPending).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("retains a contradictory 4xx carrying a retryable error code", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { lifecycle, client, engine } = makeLifecycle();
    client.createReservation.mockResolvedValue(allowResponse());
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(400, "proxy mismatch", {
        error: "INTERNAL_ERROR",
        message: "transient",
        request_id: "req-1",
      }),
    );

    await lifecycle.execute(async () => "result", [], cfg);

    expect(engine.schedule).toHaveBeenCalledTimes(1);
    expect(engine.discardPending).not.toHaveBeenCalled();
    expect(client.releaseReservation).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

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
    expect(body.action).toEqual({ kind: "unknown", name: "unknown" });
    expect(body.actual).toEqual({ unit: "USD_MICROCENTS", amount: 1000 });
    const persisted = engine.persistPending.mock.calls[0][1] as Record<string, unknown>;
    expect(body.idempotency_key).toBe(persisted.idempotency_key);
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

  it("recovers via scheduleEvent on a bodyless 410 first commit", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { lifecycle, client, engine } = makeLifecycle();
    client.createReservation.mockResolvedValue(allowResponse());
    client.commitReservation.mockResolvedValue(CyclesResponse.httpError(410, "Gone"));

    await lifecycle.execute(async () => "result", [], cfg);

    expect(engine.scheduleEvent).toHaveBeenCalledTimes(1);
    expect(client.releaseReservation).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("journals instead of releasing on an unrecognized 4xx code", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { lifecycle, client, engine } = makeLifecycle();
    client.createReservation.mockResolvedValue(allowResponse());
    client.commitReservation.mockResolvedValue(
      CyclesResponse.httpError(400, "weird", {
        error: "SOME_FUTURE_CODE",
        message: "m",
        request_id: "r",
      }),
    );

    await lifecycle.execute(async () => "result", [], cfg);

    expect(engine.schedule).toHaveBeenCalledTimes(1);
    expect(client.releaseReservation).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unclassifiable"));
    errorSpy.mockRestore();
  });

  it("journals instead of releasing on a codeless 4xx", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { lifecycle, client, engine } = makeLifecycle();
    client.createReservation.mockResolvedValue(allowResponse());
    client.commitReservation.mockResolvedValue(CyclesResponse.httpError(400, "Bad request"));

    await lifecycle.execute(async () => "result", [], cfg);

    expect(engine.schedule).toHaveBeenCalledTimes(1);
    expect(client.releaseReservation).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("never releases known spend on a genuine commit rejection", async () => {
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
    expect(client.releaseReservation).not.toHaveBeenCalled();
  });
});
