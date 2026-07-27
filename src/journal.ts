/**
 * Durable on-disk journal for pending commits awaiting retry.
 *
 * Committed spend must survive process restarts: a commit that fails
 * transiently and only lives in an in-memory retry loop vanishes if the
 * process exits, and once the reservation's grace period elapses the server
 * returns the reserved budget to the pool — the ledger under-counts real
 * spend. The journal records every pending commit before the background
 * retry starts, and removes it only on a terminal outcome. On the next
 * process start the SDK replays surviving entries: commit first
 * (idempotent), falling back to `POST /v1/events` when the reservation has
 * expired.
 *
 * Journal I/O is strictly best-effort — a failure to persist must never
 * break the commit path itself.
 *
 * Records are partitioned into per-identity subdirectories keyed by a
 * non-secret PBKDF2 fingerprint of the server plus principal (the
 * configured tenant when set — stable across API-key rotation — else the
 * API key). The derivation is byte-compatible with the Python SDK's, so
 * same-tenant clients in both languages share an identity directory and
 * can settle each other's records (safe: replay is idempotent).
 */

import { pbkdf2Sync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RECORD_VERSION = 1;
const SUFFIX = ".json";

/** Test seam: overrides the default journal location. */
let _defaultDirOverride: string | undefined;

/** @internal — test use only. */
export function _setDefaultJournalDirOverride(dir: string | undefined): void {
  _defaultDirOverride = dir;
}

/** Default location for the pending-commit journal. */
export function defaultJournalDir(): string {
  return (
    _defaultDirOverride ?? path.join(os.homedir(), ".runcycles", "commit-journal")
  );
}

const digestCache = new Map<string, string>();

/**
 * Non-secret identity for one (server, principal) pair.
 *
 * When a tenant is configured it is the principal — stable across API-key
 * rotation, and any same-tenant credential may settle the records. Without
 * a tenant the API key itself is the principal; rotating it then orphans
 * pending records under the old fingerprint (records are plain JSON, so an
 * operator can move them into the new identity directory — replay is
 * idempotent). PBKDF2 rather than a bare hash: the principal may embed a
 * credential, and a KDF makes offline recovery from a leaked directory
 * name harder for a weak user-chosen key. Rounds are deliberately modest
 * (~tens of ms cold, cached per identity per process): the principal is
 * normally a high-entropy machine credential. Parameters are fixed
 * constants and byte-compatible with the Python SDK.
 */
export function authFingerprint(
  baseUrl: string,
  apiKey: string,
  tenant?: string,
): string {
  const principal = tenant ? `tenant\n${tenant}` : `key\n${apiKey}`;
  const cacheKey = `${baseUrl}\n${principal}`;
  const cached = digestCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const digest = pbkdf2Sync(
    principal,
    `runcycles-commit-journal\n${baseUrl}`,
    30_000,
    32,
    "sha256",
  )
    .toString("hex")
    .slice(0, 16);
  if (digestCache.size >= 256) {
    digestCache.clear();
  }
  digestCache.set(cacheKey, digest);
  return digest;
}

function safeFilename(reservationId: string): string {
  const sanitized = reservationId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${sanitized}${SUFFIX}`;
}

/** Best-effort permission tightening — records carry spend metadata. */
function restrictPermissions(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // No-op semantics on platforms without POSIX modes; never blocks the write.
  }
}

export interface PendingCommitRecord {
  reservationId: string;
  baseUrl: string;
  mode: "commit" | "event";
  commitBody?: Record<string, unknown>;
  eventFallbackBody?: Record<string, unknown>;
  recordedAtMs: number;
  /**
   * Absolute wall-clock floor (ms) for the next attempt, set from a 429's
   * Retry-After. Absolute so it survives a process restart mid-wait.
   */
  notBeforeMs?: number;
}

function recordToJson(record: PendingCommitRecord): string {
  return JSON.stringify({
    version: RECORD_VERSION,
    reservation_id: record.reservationId,
    base_url: record.baseUrl,
    mode: record.mode,
    commit_body: record.commitBody ?? null,
    event_fallback_body: record.eventFallbackBody ?? null,
    recorded_at_ms: record.recordedAtMs,
    not_before_ms: record.notBeforeMs ?? null,
  });
}

function recordFromJson(raw: string): PendingCommitRecord {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const reservationId = data.reservation_id;
  const mode = data.mode ?? "commit";
  if (typeof reservationId !== "string" || reservationId === "") {
    throw new Error("journal record missing reservation_id");
  }
  if (mode !== "commit" && mode !== "event") {
    throw new Error(`journal record has unknown mode: ${String(mode)}`);
  }
  const commitBody = data.commit_body;
  const eventFallbackBody = data.event_fallback_body;
  if (mode === "commit" && (commitBody === null || typeof commitBody !== "object")) {
    throw new Error("commit-mode journal record missing commit_body");
  }
  if (
    mode === "event" &&
    (eventFallbackBody === null || typeof eventFallbackBody !== "object")
  ) {
    throw new Error("event-mode journal record missing event_fallback_body");
  }
  const notBeforeRaw = data.not_before_ms;
  return {
    reservationId,
    baseUrl: typeof data.base_url === "string" ? data.base_url : "",
    mode,
    commitBody: (commitBody ?? undefined) as Record<string, unknown> | undefined,
    eventFallbackBody: (eventFallbackBody ?? undefined) as
      | Record<string, unknown>
      | undefined,
    recordedAtMs: typeof data.recorded_at_ms === "number" ? data.recorded_at_ms : 0,
    notBeforeMs: typeof notBeforeRaw === "number" ? notBeforeRaw : undefined,
  };
}

/**
 * File-per-pending-commit journal.
 *
 * Each record is one JSON file named after its reservation id, written
 * atomically (unique temp file + rename) and deleted on a terminal
 * outcome. One file per commit avoids cross-process file locking;
 * concurrent replay by multiple processes is safe because commit and
 * event requests both carry idempotency keys.
 */
export class CommitJournal {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  /** Persist a pending commit. Never throws. */
  record(entry: PendingCommitRecord): void {
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      restrictPermissions(this.directory, 0o700);
      const target = path.join(this.directory, safeFilename(entry.reservationId));
      // Unique temp name per writer: concurrent processes may settle the
      // same reservation (replay is idempotent), and a shared temp filename
      // would let one truncate the other mid-write and atomically publish
      // partial JSON.
      const tmp = `${target}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
      try {
        fs.writeFileSync(tmp, recordToJson(entry), "utf-8");
        restrictPermissions(tmp, 0o600);
        fs.renameSync(tmp, target);
      } catch (err) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // best-effort cleanup
        }
        throw err;
      }
    } catch (err) {
      console.warn(
        `[runcycles] Failed to journal pending commit (continuing without durability): ${entry.reservationId}: ${String(err)}`,
      );
    }
  }

  /** Remove a journal entry after a terminal outcome. Never throws. */
  discard(reservationId: string): void {
    try {
      fs.rmSync(path.join(this.directory, safeFilename(reservationId)), {
        force: true,
      });
    } catch (err) {
      console.warn(
        `[runcycles] Failed to discard journal entry: ${reservationId}: ${String(err)}`,
      );
    }
  }

  /**
   * Load surviving entries for the given server. Never throws.
   *
   * Only entries recorded against the same `baseUrl` are returned —
   * defense-in-depth on top of the per-identity directory partitioning.
   * Unparseable files are renamed to `*.corrupt` so they surface to
   * operators instead of being retried forever.
   */
  loadPending(baseUrl: string): PendingCommitRecord[] {
    const entries: PendingCommitRecord[] = [];
    try {
      if (!fs.existsSync(this.directory)) {
        return entries;
      }
      const names = fs
        .readdirSync(this.directory)
        .filter((n) => n.endsWith(SUFFIX))
        .sort();
      for (const name of names) {
        const filePath = path.join(this.directory, name);
        let entry: PendingCommitRecord;
        try {
          entry = recordFromJson(fs.readFileSync(filePath, "utf-8"));
        } catch (err) {
          console.warn(
            `[runcycles] Skipping corrupt journal entry: ${filePath}: ${String(err)}`,
          );
          try {
            fs.renameSync(filePath, filePath.replace(/\.json$/, ".corrupt"));
          } catch {
            // best-effort quarantine
          }
          continue;
        }
        if (entry.baseUrl === baseUrl) {
          entries.push(entry);
        }
      }
    } catch (err) {
      console.warn(
        `[runcycles] Failed to scan commit journal: ${this.directory}: ${String(err)}`,
      );
    }
    return entries;
  }
}
