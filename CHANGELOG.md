# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.4.0] - 2026-07-27

Durable commit retries. Previously a commit that failed transiently lived only in a floating in-memory promise: `process.exit()`, a crash, or a signal dropped it, and once the reservation's grace period elapsed the server's expiry sweep returned the reserved budget to the pool, permanently under-counting spend that had already happened. Ports the full design from `cycles-client-python` v0.5.0 (PR runcycles/cycles-client-python#89, three review rounds).

### Added

- `src/journal.ts`: file-per-commit `CommitJournal` (atomic unique-temp-file write, idempotent replay). Config: `journalEnabled` (default `true`), `journalDir` (default `~/.runcycles/commit-journal`), `retryFlushTimeout` (default 10 s); env `CYCLES_JOURNAL_ENABLED`, `CYCLES_JOURNAL_DIR`, `CYCLES_RETRY_FLUSH_TIMEOUT`. Records are partitioned into per-identity subdirectories (directories `0700`, files `0600` where supported) keyed by a non-secret PBKDF2-HMAC-SHA256 fingerprint of the server plus principal — the configured `tenant` when set (rotation-safe), else the API key. The derivation is byte-compatible with the Python SDK, so same-tenant clients in both languages share an identity directory and can settle each other's records. The first engine created per identity replays surviving entries; corrupt files are renamed `*.corrupt`; a persisted `not_before_ms` floor makes `Retry-After` waits survive restarts.
- Event fallback: a commit answered `RESERVATION_EXPIRED` (budget already returned to the pool) is recovered via `POST /v1/events`, reusing the commit idempotency key with `metadata.recovered_reservation_id` / `recovery_reason` markers and no `overage_policy` (spec default `ALLOW_IF_AVAILABLE` never rejects). Applies to `withCycles` and the streaming adapter.
- Rate-limit awareness end to end: 429 / `LIMIT_EXCEEDED` on the first commit attempt schedules a retry instead of releasing the reservation, passing the server's `Retry-After` into the engine; on retried attempts the journal entry is retained and the next attempt waits at least `Retry-After`.
- Authentication failures (401/403) on any commit attempt or event fallback journal the spend instead of releasing or discarding it.
- `CommitRetryEngine.scheduleEvent()` and `flush(timeoutMs?)`.
- `flushPendingCommits(timeoutMs?)` — public, exported from the package root: waits (bounded) for all in-flight background commit retries across every engine in the process, including the engines `withCycles` and `reserveForStream` create internally. Defaults to the maximum `retryFlushTimeout` among engines. Call it before returning a handler response in serverless environments.

### Changed

- **`StreamReservation.commit()` no longer throws on transient failures.** Transport errors, 5xx, 429, 401/403, and post-expiry commits are journaled and retried in the background (with the `/v1/events` fallback once expired) and resolve normally with `finalized` remaining `true`. Only genuine rejections (e.g. `UNIT_MISMATCH`) still reset `finalized` and throw so the caller can correct and retry or release. Previously every failure threw and reset `finalized`, leaving spend recovery entirely to the caller.
- Retry-engine promises are tracked (awaitable via `flush()`) instead of floating; retries that exhaust or fail non-retryably retain their journal entry (transient/auth) or discard it (genuine rejection) instead of silently dropping the spend record.
- With `retryEnabled: false`, failed commits are journaled for next-run replay instead of silently dropped (the old drop behavior remains only when the journal is also disabled).
- **Unclassifiable 4xx commit responses no longer release or discard spend.** A 4xx is treated as a genuine rejection (release in `withCycles`, throw in `StreamReservation.commit()`, journal discard in the retry engine) only when it carries a recognized protocol error code; codeless, mangled, or forward-compat unknown codes are journaled and retained with an error log instead. HTTP 410 by status alone is now classified as `RESERVATION_EXPIRED` (catches bodyless 410s) and recovered via the `/v1/events` fallback.
- Honored server delays are clamped to 1 hour (`Retry-After` passed to `schedule()`, stashed from a 429, or a restored journal `not_before_ms` floor) — a mangled header or corrupted timestamp cannot park a spend record for days or overflow Node's 2^31-1 ms `setTimeout` limit.
- Cross-SDK journal parse strictness (Python/Java parity): records with `mode: null` or array-valued `commit_body`/`event_fallback_body` are quarantined as `*.corrupt` instead of coerced; an empty `event_fallback_body` on an expired commit is treated as absent (journal retained, no empty `/v1/events` post). A whitespace-only configured `tenant` now falls back to the API key as the journal identity principal (the raw untrimmed tenant is still used when non-blank).
- `journal.record()` also tightens permissions (0700, best-effort) on the base journal directory, and `loadPending()` garbage-collects `*.tmp` files older than one hour left behind by crashed writers.

## [0.3.4] - 2026-07-24

Protocol error handling, response-mapping correctness, and release-pipeline hardening. This is the first published release after 0.3.1; the changes previously documented as 0.3.2 and 0.3.3 are included here because those versions were never tagged or published.

### Added

- `TENANT_CLOSED` error-code support introduced in runtime spec v0.1.25.13 ([runcycles/cycles-protocol#125](https://github.com/runcycles/cycles-protocol/pull/125)): new `ErrorCode.TENANT_CLOSED` enum member, `TenantClosedError` class (thrown **at reservation time** by `withCycles` / lifecycle / `reserveForStream` via `buildProtocolException`; commit-time client errors are handled/released internally by `withCycles`, and `StreamReservation.commit()` throws generic `CyclesError`), and `CyclesProtocolError.isTenantClosed()` helper. The code is non-retryable and remains backward compatible with servers that return unknown future error codes.
- `LIMIT_EXCEEDED` error-code support per runtime spec v0.1.25.12 (revision 2026-07-04): HTTP 429 rate-limit responses (public evidence/JWKS endpoints) carry `error=LIMIT_EXCEEDED` plus `Retry-After` / `X-RateLimit-Reset` headers. New `ErrorCode.LIMIT_EXCEEDED` enum member in spec declaration order (after `MAX_EXTENSIONS_EXCEEDED`; `TENANT_CLOSED` relocated after it so the enum mirrors the spec exactly). Classified **retryable** by both `isRetryableErrorCode` and `CyclesProtocolError.isRetryable()` — 429 is transient and the spec instructs retry after the indicated delay; the status-based rule only covers ≥500, so the code-based classification carries it (this also preserves the prior `errorCodeFromString → UNKNOWN → retryable` fallback behavior). Enum-only by design, matching the `BUDGET_FROZEN`/`BUDGET_CLOSED` pattern: not a reservation-lifecycle denial, so no exception class or `buildProtocolException` mapping.
- `Retry-After` header exposure: the client now captures the HTTP `Retry-After` header (how 429 rate-limit responses carry the delay per the spec) and exposes it as `CyclesResponse.retryAfterMsHeader` (seconds → ms; non-integer forms ignored gracefully). `buildProtocolException` falls back to it for `retryAfterMs` when the body carries no `retry_after_ms` field (body wins when both are present). No auto-retry behavior change — the delay is surfaced, not consumed.
- Regression coverage confirms `listReservations` forwards and URL-encodes the additive `from` / `to`, `expires_from` / `expires_to`, and `finalized_from` / `finalized_to` ISO-8601 query parameters. The existing `params?: Record<string, string>` API already accepted them.

### Changed

- npm publish now uses npm Trusted Publishing (OIDC) instead of the long-lived `NPM_TOKEN` secret (`NODE_AUTH_TOKEN` removed from the publish job; the job already had `id-token: write` and upgrades npm, which OIDC requires at >= 11.5.1). The trusted publisher must be configured for the `runcycles` package on npmjs.com before the next tagged release. Mirrors the same change in `cycles-mcp-server`, whose v0.3.0 release initially failed on an expired token.
- `package.json` `repository.url` normalized to `git+https://...` per `npm pkg fix`, which also makes it match the exact form npm's trusted-publisher repository check expects.
- Refreshed the vendored `cycles-protocol-v0.yaml` contract fixture from v0.1.24 to the current v0.1.25.15 and aligned the exact `ErrorCode` contract assertion with `LIMIT_EXCEEDED` and `TENANT_CLOSED`.

### Security

- Forced transitive `esbuild` to >= 0.28.1 via npm `overrides`, resolving Dependabot alert #9 (low severity, dev-only: arbitrary file read via the esbuild development server on Windows; `tsup` pins `esbuild ^0.27.0` so no direct range reaches the patched version). Remove the override once `tsup` allows esbuild >= 0.28.
- Updated test-only transitive `fast-uri` from 3.1.2 to 3.1.4, resolving the high-severity host-confusion advisories reported through the Ajv contract-test toolchain. The dependency is not included in the published package.

### Fixed

- `eventCreateResponseFromWire` now maps the declared `EventCreateResponse.charged` field. Previously, the effective charge on `ALLOW_IF_AVAILABLE`-capped events was silently lost and always appeared as `undefined`.
- README error-handling docs no longer describe `CyclesTransportError` as thrown on network failure — the SDK never constructs it. Reservation-time transport failures surface as `CyclesProtocolError` with `status: -1` (`withCycles` / `reserveForStream`) or as `CyclesResponse` with `isTransportError` / `status: -1` (programmatic client); commit-time failures are retried in the background by `withCycles`, while `StreamReservation.commit()` throws and resets `finalized` for caller retry or release. The class remains exported for use in user code; a new "Transport failures (status -1)" README subsection documents the actual behavior.
- `examples/vercel-ai-sdk` chat route no longer mixes AI SDK v4 and v5 APIs (it compiled under neither while `package.json` pins `"ai": "^4.0.0"`): now pure v4 — `Message` type and `convertToCoreMessages` replace v5's `UIMessage` / `convertToModelMessages`. `runcycles` usage unchanged.

### Notes

- Library changes are additive or bug fixes; there is no breaking API or wire-format change.
- Evidence/JWKS endpoints and the remaining additive response-mapping work are outside this release and remain tracked in [#134](https://github.com/runcycles/cycles-client-typescript/issues/134).
- 339 tests pass; coverage is 98.61% statements and 99.81% lines. Lint, typecheck, build, dependency audit, and package dry-run are clean.

## [0.3.1] - 2026-05-07

npm metadata refresh for category-search discovery. **No code changes** — bundle and runtime behavior are identical to 0.3.0.

### Changed

- `package.json`: rewrote `description` to lead with the cost / action / audit pillars (*"TypeScript AI agent runtime control — enforce LLM cost limits, action permissions, and audit trails for agents before execution."*) and expanded `keywords` from 15 to 26. Drops legacy keywords (`billing`, `metering`, `api-client`, `ai`, `llm`, `agents`, `token-budget`, `spend-limit`) in favor of category-search variants (`ai-agent`, `agent-budget`, `budget-control`, `cost-enforcement`, `spending-limit`, `llm-cost`, `runtime-authority`, `action-control`, `action-authority`, `audit-trail`, `audit`, `compliance`, `multi-tenant`) plus framework targeting (`langchain`, `langgraph`, `openai-agents`, `vercel-ai-sdk`, `mcp`).

## [0.3.0] - 2026-04-27

Java parity: dynamic subject and action fields on `withCycles`.

### Added

- Dynamic subject + action fields on `withCycles` config — `tenant`, `workspace`, `app`, `workflow`, `agent`, `toolset`, `actionKind`, and `actionName` now accept `(...args: TArgs) => string | undefined` in addition to a static string. Callables are resolved against the wrapped function's per-call args; returning `undefined` falls through to the client-config default (subject) or `"unknown"` (action). Static strings unchanged. Java parity with [`cycles-spring-boot-starter#50`](https://github.com/runcycles/cycles-spring-boot-starter/pull/50). ([#72](https://github.com/runcycles/cycles-client-typescript/issues/72))

## [0.2.0] - 2026-03-24

Bug fixes, support 0.1.24 spec.

### Added

- Add badges to README for npm, CI, and license ([#24](https://github.com/runcycles/cycles-client-typescript/pull/24))
- Add documentation links section to README ([#25](https://github.com/runcycles/cycles-client-typescript/pull/25))
- Add budget and extension error codes, charged amount to event response ([#29](https://github.com/runcycles/cycles-client-typescript/pull/29))

### Changed

- Document nested withCycles behavior and recommended patterns ([#26](https://github.com/runcycles/cycles-client-typescript/pull/26))
- Claude/analyze spring issue 29 v biy9 ([#27](https://github.com/runcycles/cycles-client-typescript/pull/27))
- Change default overage policy from REJECT to ALLOW_IF_AVAILABLE ([#28](https://github.com/runcycles/cycles-client-typescript/pull/28))
- chore: bump version to 0.2.0 for protocol v0.1.24 ([#30](https://github.com/runcycles/cycles-client-typescript/pull/30))

## [0.1.2] - 2026-03-19

Fix type safety in WithCyclesConfig generics.

### Added

- Add AUDIT.md documenting protocol conformance ([#19](https://github.com/runcycles/cycles-client-typescript/pull/19))
- Add AWS Bedrock and Google Gemini budget governance examples ([#20](https://github.com/runcycles/cycles-client-typescript/pull/20))
- Add parent README for examples directory ([#21](https://github.com/runcycles/cycles-client-typescript/pull/21))
- Add API key creation guide to documentation and examples ([#22](https://github.com/runcycles/cycles-client-typescript/pull/22))

### Fixed

- Fix type safety in WithCyclesConfig generics and add compile-time type tests ([#23](https://github.com/runcycles/cycles-client-typescript/pull/23))

## [0.1.1] - 2026-03-13

Updates and bug and stability fixes, more SDK examples.

### Added

- Add manual workflow_dispatch trigger to CI publish ([#4](https://github.com/runcycles/cycles-client-typescript/pull/4))
- Add comprehensive test coverage for lifecycle, streaming, and error handling ([#7](https://github.com/runcycles/cycles-client-typescript/pull/7))
- Add comprehensive examples for Cycles budget governance ([#9](https://github.com/runcycles/cycles-client-typescript/pull/9))
- Claude/expand ai examples zj dwy ([#10](https://github.com/runcycles/cycles-client-typescript/pull/10))
- Add ESLint with typescript-eslint/recommended and coverage thresholds ([#12](https://github.com/runcycles/cycles-client-typescript/pull/12))
- Add lint and coverage enforcement to CI ([#13](https://github.com/runcycles/cycles-client-typescript/pull/13))
- Add test for commit retry exhaustion warning ([#18](https://github.com/runcycles/cycles-client-typescript/pull/18))

### Changed

- Comprehensive README rewrite for npm publication ([#5](https://github.com/runcycles/cycles-client-typescript/pull/5))
- Optimize initialization and add async disposal support ([#6](https://github.com/runcycles/cycles-client-typescript/pull/6))
- Update TEST_COVERAGE_ANALYSIS.md with final coverage results ([#8](https://github.com/runcycles/cycles-client-typescript/pull/8))
- Document withCycles client caching behavior in default client section ([#11](https://github.com/runcycles/cycles-client-typescript/pull/11))
- Document commit rollback behavior for failed commits in streaming sec… ([#14](https://github.com/runcycles/cycles-client-typescript/pull/14))
- Warn on commit retry exhaustion in CommitRetryEngine ([#15](https://github.com/runcycles/cycles-client-typescript/pull/15))

### Removed

- Remove dead code: unused constants, validateReservationId, makeClient ([#16](https://github.com/runcycles/cycles-client-typescript/pull/16))
- Remove CyclesTransportError from public exports ([#17](https://github.com/runcycles/cycles-client-typescript/pull/17))

## [0.1.0] - 2026-03-13

Initial release.

### Added

- Add TypeScript client for Cycles budget-management protocol ([#1](https://github.com/runcycles/cycles-client-typescript/pull/1))
- Add comprehensive mapper functions for wire format conversion ([#2](https://github.com/runcycles/cycles-client-typescript/pull/2))
- Add CI/CD pipeline and improve package metadata ([#3](https://github.com/runcycles/cycles-client-typescript/pull/3))
