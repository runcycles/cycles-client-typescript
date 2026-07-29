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

import { createHash, pbkdf2Sync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RECORD_VERSION = 1;
const SUFFIX = ".json";
/** Temp files from crashed writers older than this are garbage-collected. */
const STALE_TMP_MAX_AGE_MS = 3_600_000;

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
  // Presence check trims (a whitespace-only tenant is absent), but the
  // principal uses the raw untrimmed value — byte-compatible with the
  // Python and Java SDK derivations.
  const principal =
    tenant !== undefined && tenant.trim() !== ""
      ? `tenant\n${tenant}`
      : `key\n${apiKey}`;
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
  const digest = createHash("sha256").update(reservationId, "utf8").digest("hex");
  return `v2-${digest}${SUFFIX}`;
}

function legacyFilename(reservationId: string): string {
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
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("journal record must be a JSON object");
  }
  const data = parsed as Record<string, unknown>;
  if (data.version !== RECORD_VERSION) {
    throw new Error(`unsupported journal version: ${String(data.version)}`);
  }
  const reservationId = data.reservation_id;
  // An absent mode defaults to "commit"; an explicit null is rejected
  // below like any other invalid mode (parity with the Python/Java SDKs).
  const mode = data.mode === undefined ? "commit" : data.mode;
  if (typeof reservationId !== "string" || reservationId === "") {
    throw new Error("journal record missing reservation_id");
  }
  if (mode !== "commit" && mode !== "event") {
    throw new Error(`journal record has unknown mode: ${String(mode)}`);
  }
  const commitBody = data.commit_body;
  const eventFallbackBody = data.event_fallback_body;
  for (const [name, body] of [
    ["commit_body", commitBody],
    ["event_fallback_body", eventFallbackBody],
  ] as const) {
    if (
      body !== undefined &&
      body !== null &&
      (typeof body !== "object" || Array.isArray(body))
    ) {
      throw new Error(`journal record has invalid ${name}`);
    }
  }
  if (mode === "commit" && (commitBody === null || typeof commitBody !== "object")) {
    throw new Error("commit-mode journal record missing commit_body");
  }
  if (
    mode === "event" &&
    (eventFallbackBody === null || typeof eventFallbackBody !== "object")
  ) {
    throw new Error("event-mode journal record missing event_fallback_body");
  }
  if (data.base_url !== undefined && typeof data.base_url !== "string") {
    throw new Error("journal record has invalid base_url");
  }
  const recordedAtRaw = data.recorded_at_ms;
  if (
    recordedAtRaw !== undefined &&
    (!Number.isSafeInteger(recordedAtRaw) || (recordedAtRaw as number) < 0)
  ) {
    throw new Error("journal record has invalid recorded_at_ms");
  }
  const notBeforeRaw = data.not_before_ms;
  if (
    notBeforeRaw !== undefined &&
    notBeforeRaw !== null &&
    (!Number.isSafeInteger(notBeforeRaw) || (notBeforeRaw as number) < 0)
  ) {
    throw new Error("journal record has invalid not_before_ms");
  }
  return {
    reservationId,
    baseUrl: typeof data.base_url === "string" ? data.base_url : "",
    mode,
    commitBody: (commitBody ?? undefined) as Record<string, unknown> | undefined,
    eventFallbackBody: (eventFallbackBody ?? undefined) as
      | Record<string, unknown>
      | undefined,
    recordedAtMs: (recordedAtRaw as number | undefined) ?? 0,
    notBeforeMs: (notBeforeRaw as number | null | undefined) ?? undefined,
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
      // Tighten the base (parent) directory too — mkdirSync recursive may
      // have just created it with default (looser) permissions.
      restrictPermissions(path.dirname(this.directory), 0o700);
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
      const legacy = path.join(this.directory, legacyFilename(reservationId));
      if (fs.existsSync(legacy)) {
        try {
          const entry = recordFromJson(fs.readFileSync(legacy, "utf-8"));
          if (entry.reservationId === reservationId) {
            fs.rmSync(legacy, { force: true });
          }
        } catch {
          // Never delete a colliding or malformed legacy record.
        }
      }
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
      const allNames = fs.readdirSync(this.directory);
      // Best-effort GC: temp files from crashed writers older than an hour
      // can never be renamed into place — delete them so the directory does
      // not accumulate garbage forever.
      const staleBefore = Date.now() - STALE_TMP_MAX_AGE_MS;
      for (const name of allNames) {
        if (!name.endsWith(".tmp")) continue;
        const tmpPath = path.join(this.directory, name);
        try {
          if (fs.statSync(tmpPath).mtimeMs < staleBefore) {
            fs.rmSync(tmpPath, { force: true });
          }
        } catch {
          // best-effort cleanup
        }
      }
      const names = allNames.filter((n) => n.endsWith(SUFFIX)).sort();
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
        const standardPath = path.join(
          this.directory,
          safeFilename(entry.reservationId),
        );
        let duplicateOfStandard = false;
        if (filePath !== standardPath) {
          try {
            if (!fs.existsSync(standardPath)) {
              fs.renameSync(filePath, standardPath);
            } else {
              const existing = recordFromJson(
                fs.readFileSync(standardPath, "utf-8"),
              );
              if (existing.reservationId === entry.reservationId) {
                fs.rmSync(filePath, { force: true });
                duplicateOfStandard = true;
              }
            }
          } catch (err) {
            console.warn(
              `[runcycles] Could not safely migrate legacy journal filename for ${entry.reservationId}: ${String(err)}`,
            );
          }
        }
        if (duplicateOfStandard) {
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
