# Cycles Protocol v0.1.25 — Client (TypeScript) Audit

**Date:** 2026-07-28 (v0.4.1 — spec review round 5: server-authoritative heartbeat scheduling from the new `remaining_ttl_ms` field (spec PR #148) on create/extend responses — `leadFloor = max(0, remaining − rtt)`, next beat at `max(0, leadFloor − min(leadFloor/2, max(1 s, 2×maxRtt)))` after response receipt, exact first-beat delay from the create response (no immediate prime), heuristic `leadMin` skip bypassed in field mode, same-key transient retries at `clamp(lead/4, 1 s, 30 s)`, seamless heuristic fallback when the field is absent. The `(grant, elapsed)` band is reframed as best-effort fallback: regime detection without the field is formally undecidable (sticky window `grant ∈ [0.75×min(ttl/2, 30 s), 0.9×ttl)`). 445 tests pass at 98.9% line coverage.),
2026-07-27 (v0.4.1 — heartbeat measured-grant lead accounting (v2.3) fixes expiry drift and halves `max_extensions` consumption; spec review round 4: first beat fires immediately (delay 0 — any bounded delay can outlive a small capped lease) and cadence is regime-split (real per-extend grants tighten to `clamp(grant/2, 500 ms, ttl/2)`; lead-clamped grants — non-positive, or `< 0.9×ttl` and within the two-sided `0.75–1.25×`-elapsed band (Rust-port finding: an upper bound alone made the post-skip hold sticky) — hold at `min(ttl/2, 30 s)` with a once-per-heartbeat warn); the HTTP `Date` header is fully out of the heartbeat (`computeEffectiveTtlMs` deleted; `serverDateMs` stays as a general accessor); `extend_by_ms` always the requested ttl; permanent extend rejections (incl. `TENANT_CLOSED`, `NOT_FOUND`) stop the heartbeat; extend retries reuse the idempotency key; estimate-fallback commits marked `metadata.actual_source="estimate"`. 435 tests pass at 99.0% line coverage.),
2026-07-27 (v0.4.0 — durable commit retries: on-disk pending-commit journal with next-run replay and POST /v1/events recovery; first-attempt 429/401/403 never release; Retry-After persisted; streaming commit() resolves on transient failures. Review round 2 adds `flushPendingCommits()`, unclassifiable-4xx retention, 410-by-status expiry, delay clamps, and journal-parse strictness. See the dated entries below. 407 tests pass at 99.0% line coverage.),
2026-07-24 (v0.3.4 release prep — package and changelog aligned; vendored contract fixture refreshed from runtime protocol v0.1.24 to v0.1.25.15 at `cycles-protocol@99f1391`; exact `ErrorCode` contract assertion updated for `LIMIT_EXCEEDED` and `TENANT_CLOSED`; test-only `fast-uri` updated to 3.1.4. Clean install and audit pass with zero vulnerabilities; 339 tests pass at 98.61% statement / 99.81% line coverage; lint, typecheck, build, and package dry-run are clean.),
2026-07-10 (v0.3.4 — `TENANT_CLOSED` support from runtime spec v0.1.25.13: `ErrorCode.TENANT_CLOSED`, exported `TenantClosedError`, `CyclesProtocolError.isTenantClosed()`, and reservation-time typed exception mapping. Also `LIMIT_EXCEEDED` support from v0.1.25.12, retry classification, and `Retry-After` header exposure through `CyclesResponse.retryAfterMsHeader`.),
2026-07-04 (v0.3.4 — fixes the `EventCreateResponse.charged` mapper drop found by fleet audit #134 item 1: the field was declared on the interface but `eventCreateResponseFromWire` never mapped it, so the effective charge on `ALLOW_IF_AVAILABLE`-capped events was silently lost. Two regression tests pin presence and absence. Remaining audit findings stay tracked in #134.),
2026-07-03 (integration-test-only, no version bump — the live-server "health check" test now probes the public `/actuator/health/readiness` endpoint instead of aggregate `/actuator/health`, which requires `X-Admin-API-Key` since cycles-server v0.1.25.45 and fails closed with 500 when the server has no admin key configured. Would have failed the org nightly Full-Stack Integration once the Python step ahead of it was fixed. No library code change.),
2026-05-22 (included in v0.3.4; 0.3.3 was not separately published — regression coverage for `expires_from`/`expires_to` and `finalized_from`/`finalized_to` ISO-8601 window-filter passthrough on `listReservations`.),
2026-05-21 (included in v0.3.4; 0.3.2 was not separately published — regression coverage for `from` / `to` ISO-8601 window-filter passthrough on `listReservations`.),
2026-03-19 (updated), 2026-03-14 (initial)
**Spec:** `cycles-protocol-v0.yaml` (OpenAPI 3.1.0, v0.1.25)
**Client:** `runcycles` (Node 20+ / native fetch / TypeScript 6)
**Server audit:** See `cycles-server/AUDIT.md` (all passing)

---

## 2026-07-28 — Server-authoritative heartbeat scheduling (`remaining_ttl_ms`, v0.4.1)

Round-5 spec review (user-approved): regime detection from
`(grant, elapsed)` alone is formally undecidable — any per-extend grant
in the sticky window `[0.75×min(ttl/2, 30 s), 0.9×ttl)` reproduces the
elapsed gap at the held cadence and misclassifies permanently (ttl 24 s
with +10 s grants: held cadence 12 s, ratio 10/12 ≈ 0.83 stays inside
the band while the lease erodes to a lapse). Spec PR #148 therefore
adds `remaining_ttl_ms` (integer, int64, ≥0; same clock snapshot as
`expires_at_ms`; present on successful live-reservation responses,
absent on dry-run/DENY and older servers) to both
ReservationCreateResponse and ReservationExtendResponse, and both
heartbeats treat it as NORMATIVE when present: with `rtt` the measured
monotonic round-trip of that call (0 when unknown; per-heartbeat max
tracked), `leadFloor = max(0, remaining − rtt)`, `retryReserve =
min(leadFloor/2, max(1 s, 2×maxRtt))`, next beat at `max(0, leadFloor −
retryReserve)` after response receipt, recomputed from every successful
response carrying the field; expiry differences never accumulate in
this mode and the heuristic `leadMin` skip is bypassed (exact schedule;
a heuristic skip could push a beat past the real lease). A create
response with the field derives the FIRST delay from the same formula
instead of the immediate prime — a capped 1 s lease gets its first beat
at 500 ms, inside the real lease, and no `max_extensions` slot is
wasted priming under a max-lead clamp. Transient failures retry with
the SAME idempotency key after `clamp(lead/4, 1 s, 30 s)` (lead = last
`leadFloor` decayed by monotonic elapsed). The grants/lead bookkeeping
keeps running underneath so the v2.3 band heuristic — now explicitly
best-effort, for servers clamping only the per-extend delta — takes
over seamlessly if the field disappears mid-flight; legacy servers get
the unchanged fallback behavior. Parsed into
`ReservationCreateResponse.remainingTtlMs` /
`ReservationExtendResponse.remainingTtlMs`. 445 tests pass; line
coverage 98.9%, branch 93.9% (gates 95/85); lint and typecheck clean.

## 2026-07-27 — Heartbeat drift fix + estimate-as-actual marker (v0.4.1)

Both heartbeats extended by the full `ttlMs` every `ttl/2` beat while the
server extends relative to current `expires_at_ms`, drifting expiry
outward `ttl/2` per beat and burning `max_extensions` twice as fast as
needed. Now measured-grant lead accounting (v2.3): each beat computes a
rigorous lower bound `leadMin = grantsSum − elapsed`, where grants are
differences of successive server-returned `expires_at_ms` values (same
server clock frame; requested-ttl fallback when a 2xx carries none;
negative grants count as 0) and elapsed is client-monotonic — no
cross-clock arithmetic, and `leadMin` starts at 0 because the initial
grant has no safe same-clock anchor. A beat is skipped only when
`leadMin ≥ 1.5×lastGrant`; otherwise it extends by the REQUESTED
`ttl_ms` (the server owns clamping). Spec review round 4: the first beat
fires IMMEDIATELY (delay 0) — any bounded first-beat delay can outlive a
small capped lease (`max_reservation_ttl_ms` caps silently; no
effective-TTL response field) — priming the lease with a real measured
grant at ~t=0; the 0 delay applies to the first schedule only, so a
transiently failed first attempt retries after the full held interval
(no hot loop) with the SAME idempotency key. Cadence is regime-split:
grant-derived cadence is only valid for a real per-extend grant. Under a
maximum-LEAD clamp (server holds `expires_at_ms ≈ now + L`) successive
`expires_at_ms` differences measure elapsed time, not lease — deriving
cadence from them would collapse to the 500 ms floor and burn
`max_extensions` in seconds — so a grant that is non-positive, or both
`< 0.9×ttl` and within the two-sided `0.75–1.25×` band of the elapsed
time since the last applied extend, HOLDS the cadence at
`min(ttl/2, 30 s)`, warns once per heartbeat that the server appears to
clamp lease lead and the extension budget will deplete, and keeps
extending every beat (`lastGrant ≈ elapsed` keeps `leadMin` under the
skip threshold — desired liveness). The band is two-sided (Rust-port
finding, adopted fleet-wide): after a `leadMin` skip the next grant
arrives across a doubled gap, so a genuine grant-clamped server
(cadence `grant/2`) also shows `grant ≈ elapsed` exactly once — an
upper bound alone classified it as lead-clamped and the hold
self-sustained (at the held cadence grant stays `≤` elapsed forever;
a 15 s-per-extend lease banks +15 s per 30 s and decays to a lapse).
With the band, a real lead clamp tracks any gap at ratio ≈ 1 and stays
held; the post-skip real grant lands in the hold once, then at the held
cadence its ratio falls to ≈ 0.5, exits the band, and the cadence
re-tightens. A real grant re-derives `clamp(grant/2, 500 ms, ttl/2)` —
a grant-size clamp (24 h request granted 1 h) tightens the beats to
30 min automatically. Failed extends retry next beat at the current cadence
with the SAME idempotency key (lost responses cannot double-extend);
410 / `RESERVATION_EXPIRED` / `RESERVATION_FINALIZED` /
`MAX_EXTENSIONS_EXCEEDED` / `TENANT_CLOSED` / `NOT_FOUND` stop the
heartbeat permanently. This replaces the earlier schemes on this branch:
alternate-beat (every steady-state attempt at exactly `ttl/2` lead;
lapsed for small ttls), lead-estimate v2 (counted an unmeasurable
initial `+ttl` of lead; used the HTTP `Date` header for correctness),
and v2.2 (Date-hinted bounded first-beat delay; elapsed-sized grants
could tighten the cadence). Rounds 3–4 take `Date` fully out of the
heartbeat: RFC 9110 makes it a whole-second best-effort origination time
replaceable by intermediaries, and in the reference server
`expires_at_ms` comes from Redis `TIME` while `Date` comes from the
servlet container; with the immediate first beat there is no consumer
left, so `computeEffectiveTtlMs` is deleted (`CyclesResponse.serverDateMs`
remains a general accessor). Also, estimate-fallback commits (`actual`
not configured) carry `metadata.actual_source = "estimate"`, which flows
into the `/v1/events` fallback body; streaming commits always take an
explicit actual and are unmarked. 435 tests pass; line coverage 99.0%,
branch 94.2% (gates 95/85); lint and typecheck clean.

## 2026-07-27 — Durable-retry review fixes (PR #172 round 2)

Adversarial-review fixes on the durability feature: public
`flushPendingCommits(timeoutMs?)` flushes every engine in the process
(engines self-register; serverless handlers flush before returning);
unclassifiable 4xx (codeless or unrecognized error code) now retains the
journal instead of releasing/discarding, and bodyless HTTP 410 is
classified as expired; honored `Retry-After`/restored floors clamped to
1 h; flush race timer cleared; base journal dir chmod 0700 and stale
`*.tmp` GC; journal parse rejects `mode: null` and array bodies; empty
event fallback treated as absent; whitespace-only tenant falls back to
the API-key principal. 407 tests pass; line coverage 99.0%, branch 93.9%
(gates 95/85); lint and typecheck clean. v0.4.0.

## 2026-07-27 — Durable commit retries (journal + /v1/events fallback)

Ports the cycles-client-python v0.5.0 durability design (PR
runcycles/cycles-client-python#89, all three review rounds): pending
commits are journaled to a per-identity directory (tenant-keyed PBKDF2
fingerprint, byte-compatible with the Python SDK; `0700`/`0600` modes;
unique per-writer temp files) before background retry, replayed on the
next run, and recovered via `POST /v1/events` when the reservation
expired. First-attempt 429 and 401/403 schedule retries instead of
releasing; `Retry-After` floors persist across restarts as
`not_before_ms`. `StreamReservation.commit()` now resolves on transient
failures (journaled) and throws only on genuine rejections. 384 tests
pass; line coverage 98.83%, branch 93.3% (gates 95/85); lint, typecheck,
and build clean. v0.4.0.

## 2026-07-26 — development and security-workflow maintenance

Dependabot PRs #164–#169 update OSSF Scorecard to 2.4.4, the SHA-pinned CodeQL
SARIF uploader to 4.37.3 and checkout to 7.0.1, plus the resolved development
toolchain to ESLint 10.8.0 and TypeScript ESLint parser/plugin 8.65.0. These
updates affect CI, linting, and the lockfile only; published client code,
package dependencies, public types, wire mappers, and protocol behavior are
unchanged. Node 20/22 tests, 95%+ coverage, typecheck, lint, build, package,
CodeQL, and audit checks passed on all six heads.

## Summary

The table covers the SDK surface implemented in this repository. The v0.1.25.15 evidence/JWKS endpoints and remaining additive response fields are not yet modeled; those known gaps remain explicitly deferred to [#134](https://github.com/runcycles/cycles-client-typescript/issues/134) and are not claimed as part of v0.3.4.

| Category | Pass | Issues |
|----------|------|--------|
| Implemented Endpoints & HTTP Methods | 9/9 | Evidence/JWKS deferred to #134 |
| Request Schemas (field names & JSON keys) | 6/6 | 0 |
| Response Schemas (field names & JSON keys) | 10/10 | 0 |
| Nested Object Schemas | 8/8 | 0 |
| Enum Values | 5/5 | 0 |
| Auth Header (X-Cycles-API-Key) | — | 0 |
| Idempotency (header ↔ body sync) | — | 0 |
| Subject Validation | — | 0 |
| Response Header Capture | — | 0 |
| Client-Side Spec Constraint Validation | — | 0 |
| Wire-Format Mapping (camelCase ↔ snake_case) | — | 0 |
| Lifecycle Orchestration | — | 0 |
| Type Safety (`WithCyclesConfig` generics) | — | 0 (fixed) |
| Compile-Time Type Tests | — | 0 |

**Overall: Client is protocol-conformant.** All endpoints, schemas, field names, JSON keys, and enum values match the OpenAPI spec. Wire-format mappers translate between camelCase TypeScript and snake_case wire format for every request and response. No open issues.

---

## Audit Scope

Compared the following across spec YAML and client TypeScript source:
- All 9 endpoint paths, HTTP methods, and path/query parameters
- All 6 request body wire-format mappers vs spec schemas
- All 10 response model wire-format mappers vs spec schemas
- All 5 enum types and their values
- Nested object schemas (Subject, Action, Amount, SignedAmount, Caps, CyclesMetrics, Balance, ErrorResponse)
- Auth and idempotency header handling
- Subject constraint validation (at least one standard field)
- Validation functions vs spec min/max bounds
- Wire-format mapping (camelCase TypeScript ↔ snake_case JSON) for all request and response types
- Lifecycle orchestration (reserve → execute → commit/release)

---

## PASS — Correctly Implemented

### Endpoints (all 9 match spec)

| Spec Endpoint | Client Method | HTTP Method | Match |
|---|---|---|---|
| `/v1/decide` | `client.decide()` | POST | PASS |
| `/v1/reservations` (create) | `client.createReservation()` | POST | PASS |
| `/v1/reservations` (list) | `client.listReservations()` | GET | PASS |
| `/v1/reservations/{reservation_id}` | `client.getReservation()` | GET | PASS |
| `/v1/reservations/{reservation_id}/commit` | `client.commitReservation()` | POST | PASS |
| `/v1/reservations/{reservation_id}/release` | `client.releaseReservation()` | POST | PASS |
| `/v1/reservations/{reservation_id}/extend` | `client.extendReservation()` | POST | PASS |
| `/v1/balances` | `client.getBalances()` | GET | PASS |
| `/v1/events` | `client.createEvent()` | POST | PASS |

### Request Schemas (all match spec JSON keys via wire-format mappers)

**ReservationCreateRequest** — spec required: `[idempotency_key, subject, action, estimate]`
- Mapper `reservationCreateRequestToWire()` in `mappers.ts` maps: `idempotencyKey` → `idempotency_key`, `ttlMs` → `ttl_ms`, `gracePeriodMs` → `grace_period_ms`, `overagePolicy` → `overage_policy`, `dryRun` → `dry_run`, plus pass-through fields (`subject`, `action`, `estimate`, `metadata`) — all wire keys match spec

**CommitRequest** — spec required: `[idempotency_key, actual]`
- Mapper `commitRequestToWire()` maps: `idempotencyKey` → `idempotency_key`, plus `actual`, `metrics` (via `metricsToWire`), `metadata` — all match spec

**ReleaseRequest** — spec required: `[idempotency_key]`
- Mapper `releaseRequestToWire()` maps: `idempotencyKey` → `idempotency_key`, plus `reason` — all match spec

**DecisionRequest** — spec required: `[idempotency_key, subject, action, estimate]`
- Mapper `decisionRequestToWire()` maps: `idempotencyKey` → `idempotency_key`, plus `subject`, `action`, `estimate`, `metadata` — all match spec

**EventCreateRequest** — spec required: `[idempotency_key, subject, action, actual]`
- Mapper `eventCreateRequestToWire()` maps: `idempotencyKey` → `idempotency_key`, `overagePolicy` → `overage_policy`, `clientTimeMs` → `client_time_ms`, plus `subject`, `action`, `actual`, `metrics`, `metadata` — all match spec

**ReservationExtendRequest** — spec required: `[idempotency_key, extend_by_ms]`
- Mapper `reservationExtendRequestToWire()` maps: `idempotencyKey` → `idempotency_key`, `extendByMs` → `extend_by_ms`, plus `metadata` — all match spec

### Response Schemas (all match spec JSON keys via wire-format mappers)

| Spec Schema | Client Mapper | Wire Keys Parsed | Match |
|---|---|---|---|
| `ReservationCreateResponse` | `reservationCreateResponseFromWire()` | `decision`, `reservation_id`, `affected_scopes`, `expires_at_ms`, `scope_path`, `reserved`, `caps`, `reason_code`, `retry_after_ms`, `balances` | PASS |
| `CommitResponse` | `commitResponseFromWire()` | `status`, `charged`, `released`, `balances` | PASS |
| `ReleaseResponse` | `releaseResponseFromWire()` | `status`, `released`, `balances` | PASS |
| `DecisionResponse` | `decisionResponseFromWire()` | `decision`, `caps`, `reason_code`, `retry_after_ms`, `affected_scopes` | PASS |
| `EventCreateResponse` | `eventCreateResponseFromWire()` | `status`, `event_id`, `charged`, `balances` | PASS |
| `ReservationExtendResponse` | `reservationExtendResponseFromWire()` | `status`, `expires_at_ms`, `balances` | PASS |
| `BalanceResponse` | `balanceResponseFromWire()` | `balances`, `has_more`, `next_cursor` | PASS |
| `ReservationDetail` | `reservationDetailFromWire()` | `reservation_id`, `status`, `idempotency_key`, `subject`, `action`, `reserved`, `committed`, `created_at_ms`, `expires_at_ms`, `finalized_at_ms`, `scope_path`, `affected_scopes`, `metadata` | PASS |
| `ReservationSummary` | `reservationSummaryFromWire()` | `reservation_id`, `status`, `idempotency_key`, `subject`, `action`, `reserved`, `created_at_ms`, `expires_at_ms`, `scope_path`, `affected_scopes` | PASS |
| `ReservationListResponse` | `reservationListResponseFromWire()` | `reservations`, `has_more`, `next_cursor` | PASS |

### Nested Object Schemas (all match)

| Spec Schema | Client Mapper | Wire Keys | Match |
|---|---|---|---|
| `Subject` | `subjectToWire()` / `subjectFromWire()` | `tenant`, `workspace`, `app`, `workflow`, `agent`, `toolset`, `dimensions` | PASS |
| `Action` | `actionToWire()` / `actionFromWire()` | `kind`, `name`, `tags` | PASS |
| `Amount` | `amountFromWire()` | `unit`, `amount` | PASS |
| `SignedAmount` | `signedAmountFromWire()` | `unit`, `amount` | PASS |
| `Caps` | `capsFromWire()` | `max_tokens`, `max_steps_remaining`, `tool_allowlist`, `tool_denylist`, `cooldown_ms` | PASS |
| `StandardMetrics` | `metricsToWire()` | `tokens_input`, `tokens_output`, `latency_ms`, `model_version`, `custom` | PASS |
| `Balance` | `balanceFromWire()` | `scope`, `scope_path`, `remaining`, `reserved`, `spent`, `allocated`, `debt`, `overdraft_limit`, `is_over_limit` | PASS |
| `ErrorResponse` | `errorResponseFromWire()` | `error`, `message`, `request_id`, `details` | PASS |

### Enum Values (all match spec)

| Spec Enum | Client Enum | Values | Match |
|---|---|---|---|
| `DecisionEnum` | `Decision` | `ALLOW`, `ALLOW_WITH_CAPS`, `DENY` | PASS |
| `UnitEnum` | `Unit` | `USD_MICROCENTS`, `TOKENS`, `CREDITS`, `RISK_POINTS` | PASS |
| `CommitOveragePolicy` | `CommitOveragePolicy` | `REJECT`, `ALLOW_IF_AVAILABLE`, `ALLOW_WITH_OVERDRAFT` | PASS |
| `ReservationStatus` | `ReservationStatus` | `ACTIVE`, `COMMITTED`, `RELEASED`, `EXPIRED` | PASS |
| `ErrorCode` | `ErrorCode` | All 12 spec values + `UNKNOWN` (client fallback) | PASS |

Note: Client `ErrorCode` adds `UNKNOWN` as a fallback for unrecognized server error codes. This is a client-side convenience and does not violate the spec.

### Auth & Idempotency (correct)

- **X-Cycles-API-Key**: Set on all requests via `CyclesClient` constructor headers in `client.ts`
- **X-Idempotency-Key**: Extracted from wire-format request body `idempotency_key` field in `_post()` (`client.ts`) and set as header. Header and body values always match (copied from body to header), satisfying the spec rule: "If X-Idempotency-Key header is present and body.idempotency_key is present, they MUST match."

### Subject Validation (correct)

- `validateSubject()` in `validation.ts` checks all 6 standard fields (tenant, workspace, app, workflow, agent, toolset) — at least one must be present, matching spec `anyOf` constraint
- `getBalances()` in `client.ts` enforces that at least one subject filter query parameter is provided (spec normative requirement)

### Response Header Capture (correct)

- `_handleResponse()` in `client.ts` captures `x-request-id`, `x-ratelimit-remaining`, `x-ratelimit-reset`, `x-cycles-tenant`
- Exposed via `CyclesResponse` properties

### Client-Side Spec Constraint Validation (correct)

All spec constraints are validated via explicit validation functions in `validation.ts`:

- `validateNonNegative()`: `Amount.amount >= 0` (spec `minimum: 0`)
- `validateTtlMs()`: 1000–86400000 (spec `minimum: 1000, maximum: 86400000`)
- `validateGracePeriodMs()`: 0–60000 (spec `minimum: 0, maximum: 60000`)
- `validateExtendByMs()`: 1–86400000 (spec `minimum: 1, maximum: 86400000`)

### Lifecycle Orchestration (correct)

- Reserve → Execute → Commit flow with proper cleanup (release on failure) in `lifecycle.ts`
- Heartbeat-based TTL extension using the `extend` endpoint — server-authoritative scheduling from `remaining_ttl_ms` when present (spec PR #148; see the 2026-07-28 v0.4.1 entry); fallback: measured-grant lead accounting, immediate first beat (delay 0), cadence `clamp(grant/2, 500, ttlMs/2)` for real per-extend grants, held at `min(ttlMs/2, 30 s)` under a suspected lead clamp (see the 2026-07-27 v0.4.1 entry)
- Commit retry engine for transient failures (transport errors, 5xx) with exponential backoff in `retry.ts`
- Dry-run handling returns decision/caps without executing guarded function
- `DENY` decision correctly raises typed `CyclesProtocolError`
- `ALLOW_WITH_CAPS` correctly propagates `Caps` via `CyclesContext`
- Lifecycle instance cached at decoration time (deferred client resolution on first call)
- `AsyncLocalStorage`-based context propagation (safe for concurrent async tasks)
- Streaming support via `reserveForStream()` in `streaming.ts` — returns a `StreamReservation` handle with manual `commit()` / `release()` and automatic heartbeat

### HTTP Status Code Handling (correct)

- `CyclesResponse` correctly classifies 2xx (success), 4xx (client error), 5xx (server error)
- Error responses parsed via `errorResponseFromWire()` with `ErrorCode` mapping
- Typed exceptions: `BudgetExceededError`, `OverdraftLimitExceededError`, `DebtOutstandingError`, `ReservationExpiredError`, `ReservationFinalizedError`
- Transport failures surface as `status: -1`: HOF paths (`withCycles` / `reserveForStream`) throw `CyclesProtocolError` with `status: -1`; the programmatic client returns `CyclesResponse` with `isTransportError` set (`CyclesResponse.transportError()` in `response.ts`). `CyclesTransportError` is exported for user code but never thrown by the SDK (see 2026-07-09 entry below)

### Type Safety — `WithCyclesConfig` Generics (fixed)

**Issue:** `WithCyclesConfig.estimate` was typed as `number | ((...args: unknown[]) => number)`, which rejected typed callbacks like `(prompt: string) => prompt.length * 5` because `unknown` is not assignable to `string`. Same issue with `actual` accepting `(result: unknown) => number`.

**Fix:** Made `WithCyclesConfig` generic: `WithCyclesConfig<TArgs extends unknown[] = unknown[], TResult = unknown>`. The `withCycles` HOF now threads `TArgs` and `TResult` from the wrapped function's signature into the config, so `estimate` and `actual` callbacks are fully type-safe.

**Files changed:**
- `src/lifecycle.ts` — `WithCyclesConfig` interface now generic
- `src/withCycles.ts` — `options` parameter uses `WithCyclesConfig<TArgs, TResult>`

**Regression prevention:**
- `tsconfig.typecheck.json` — extends base tsconfig, includes `tests/` directory for `tsc --noEmit`
- `tests/withCycles.typecheck.ts` — compile-time-only type test with `@ts-expect-error` assertions that verify typed callbacks compile and mismatched types are rejected
- `package.json` — `typecheck` script updated to use `tsconfig.typecheck.json`
- CI already runs `npm run typecheck` — these type tests are now covered

**Validation:** typecheck PASS, build PASS, lint PASS, 211/211 tests PASS.

---

### OpenAPI Contract Tests (added 2026-03-28)

Added `tests/contract.test.ts` — 92 automated tests that load the OpenAPI spec YAML and validate request/response fixtures against the actual JSON Schema definitions using Ajv:

- **Request schemas validated:** `DecisionRequest`, `ReservationCreateRequest`, `CommitRequest`, `EventCreateRequest` — valid bodies pass, missing required fields and additional properties are rejected
- **Response schemas validated:** `DecisionResponse`, `ReservationCreateResponse`, `CommitResponse`, `EventCreateResponse`, `ErrorResponse` — valid bodies pass, missing required fields and invalid enum values are rejected
- **Leaf object schemas validated:** `Amount`, `Subject`, `Action` — constraints (required fields, additionalProperties, minimum values, anyOf) enforced
- **Enum completeness verified:** `UnitEnum` has exactly `[USD_MICROCENTS, TOKENS, CREDITS, RISK_POINTS]`; `ErrorCode` has all 17 expected values
- Spec fixture stored at `tests/fixtures/cycles-protocol-v0.yaml`
- Dev dependencies added: `ajv`, `ajv-formats`, `yaml`

---

### Dynamic subject + action fields on `withCycles` (added 2026-04-27)

**Issue [#72](https://github.com/runcycles/cycles-client-typescript/issues/72):** Subject fields (`tenant`, `workspace`, `app`, `workflow`, `agent`, `toolset`) and action fields (`actionKind`, `actionName`) on `WithCyclesConfig` were `string | undefined` only — no first-class way to derive them from per-call args. Java parity: `cycles-spring-boot-starter` 0.2.1 shipped SpEL on `@Cycles` subject fields ([#50](https://github.com/runcycles/cycles-spring-boot-starter/pull/50)).

**Fix:** All eight string fields now accept `(...args: TArgs) => string | undefined` in addition to a static string, resolved at `AsyncCyclesLifecycle.execute` against the wrapped function's args via a single `evaluateStringField` helper that mirrors the existing `evaluateAmount` / `evaluateActual` pattern. A callable returning `undefined` falls through to the client-config default (subject fields) or `"unknown"` (action fields) — matching the static-string fallback. Callables run before the reservation is created; throwing propagates fail-fast. Static strings unchanged (regression-tested).

**Files changed:**
- `src/lifecycle.ts` — widened 6 subject + 2 action field types in `WithCyclesConfig`; added `evaluateStringField` helper; threaded `args` into `buildReservationBody` and the call site in `execute`
- `tests/lifecycle.test.ts` — new `dynamic subject and action fields` describe block: callable resolution, undefined fall-through to default, static-string regression, throwing-callable propagation, all-six-fields smoke test, action-kind/name callable + undefined + static
- `tests/withCycles.typecheck.ts` — appended type-level tests with `@ts-expect-error` for mismatched-args (subject + action), valid typed callbacks, and static regressions
- `README.md` — documented callable form on action + subject blocks of the `WithCyclesConfig` snippet; added a "Dynamic subject and action fields" usage example

**Validation:** typecheck PASS, lint PASS, build PASS, all tests PASS, coverage ≥95% lines / ≥85% branches.

---

## Verdict

The client is **fully protocol-conformant** with the Cycles Protocol v0.1.23 OpenAPI spec. All 9 endpoints, 6 request schemas, 10 response schemas, 5 enum types, and all nested object serializations match the spec exactly. Wire-format mappers correctly translate between camelCase TypeScript and snake_case JSON throughout. Auth headers, idempotency handling, subject validation, response header capture, and spec constraint validation all follow spec normative rules. OpenAPI contract tests (90 tests) provide automated regression coverage against the spec YAML. No open issues.

---

## 0.3.1 — npm Metadata Refresh (2026-05-07)

**Files:** `package.json`. **No code changes.** Bundle, runtime behavior, protocol conformance, and test coverage are identical to 0.3.0.

- **Description rewritten** to lead with the cost / action / audit pillars: *"TypeScript AI agent runtime control — enforce LLM cost limits, action permissions, and audit trails for agents before execution."*
- **Keywords expanded** 15 → 26. Drops legacy keywords (`billing`, `metering`, `api-client`, `ai`, `llm`, `agents`, `token-budget`, `spend-limit`) in favor of category-search variants and framework targeting (`langchain`, `langgraph`, `openai-agents`, `vercel-ai-sdk`, `mcp`).

Driven by package-portfolio SEO diagnostic. The cost / action / audit triad now leads the description, matching the three pillars of Cycles' value proposition.

---

## README Transport-Error Docs + Vercel AI SDK Example Fix (2026-07-09)

**Files:** `README.md`, `examples/vercel-ai-sdk/app/api/chat/route.ts`, `CHANGELOG.md`. **No library code changes** — docs and example only; bundle and runtime behavior unchanged.

### README: `CyclesTransportError` documented as thrown, but never constructed

The README's error-handling section imported `CyclesTransportError` and showed an `err instanceof CyclesTransportError` catch branch, and the exception-hierarchy table described it as "Network-level failure (connection, DNS, timeout)" — implying the SDK throws it. Nothing in `src/` ever constructs it. Actual behavior:

- **HOF paths (`withCycles` / `reserveForStream`):** transport failure at reserve time throws `CyclesProtocolError` with `status: -1` and `errorCode` `undefined`; commit-time transport failures in `withCycles` are retried by the commit retry engine (`retry.ts`), not thrown; `StreamReservation.commit()` instead throws and resets `finalized` so the caller can retry or `release()`.
- **Programmatic client:** never throws on transport failure — returns `CyclesResponse` with `isTransportError` set and `status` of `-1` (`CyclesResponse.transportError()` in `response.ts`).

**Fix:** removed the dead `instanceof CyclesTransportError` branch, added a `status === -1` check inside the `CyclesProtocolError` branch, corrected the hierarchy-table row (class remains exported for user code), and added a "Transport failures (status -1)" subsection covering both API surfaces. Wording matches the docs site (`cycles-docs/how-to/error-handling-patterns-in-typescript.md`). Also corrected the stale statement in this file's "HTTP Status Code Handling" section. `CyclesTransportError` remains exported from `src/index.ts` — no API change.

### `examples/vercel-ai-sdk`: route mixed AI SDK v4 and v5 APIs

`app/api/chat/route.ts` used AI SDK v5 APIs (`UIMessage` type, `convertToModelMessages`) alongside v4 APIs (`usage.promptTokens` / `usage.completionTokens`, `result.toDataStreamResponse()`) while `package.json` pins `"ai": "^4.0.0"` — the file compiled under neither major version.

**Fix:** converted to pure v4: `type Message` (with `.content`) instead of `UIMessage`, synchronous `convertToCoreMessages(messages)` instead of `await convertToModelMessages(messages)`. The already-v4-correct parts (`usage.promptTokens` / `completionTokens`, `toDataStreamResponse()`) are unchanged, as is all `runcycles` usage (`reserveForStream`, `handle.commit()` / `handle.release()` — previously verified correct). No other files in the example used v5 APIs (verified by grep for `UIMessage`, `convertToModelMessages`, `.parts`, `maxOutputTokens`, `inputTokens`/`outputTokens`).

**Validation:** library `src/` untouched. Example typecheck (`tsc --noEmit`) skipped: `npm install` in the example directory could not complete on the fixing machine (known npm-internal "Exit handler never called" bug). Verified instead by review against the AI SDK v4 API surface (`Message` / `.content`, `convertToCoreMessages`, `usage.promptTokens` / `completionTokens`, `result.toDataStreamResponse()`) and by grep confirming no v5 identifiers remain anywhere in the example.

---

## Publish Pipeline — npm Trusted Publishing (2026-07-21)

**Files:** `.github/workflows/ci.yml`, `package.json`, `CHANGELOG.md`. **No library code changes.**

**Issue:** The publish job authenticated with the long-lived org-level `NPM_TOKEN` secret. The same token expired and broke the `cycles-mcp-server` v0.3.0 release (npm reports an expired token on a scoped package as `E404` on PUT), requiring manual rotation. Any repo publishing with that shared token has the same failure mode.

**Fix:** The publish job now uses npm Trusted Publishing (OIDC): `NODE_AUTH_TOKEN` removed. The job already carried `id-token: write` and `npm install -g npm@latest` (OIDC requires npm >= 11.5.1; Node 20 bundles npm 10), so no other workflow changes were needed. `package.json` `repository.url` normalized to `git+https://github.com/runcycles/cycles-client-typescript.git` via `npm pkg fix` — this is also the exact form npm's trusted-publisher repository check compares against. The trusted publisher for the `runcycles` package must be configured on npmjs.com (GitHub Actions: `runcycles/cycles-client-typescript`, workflow `ci.yml`, no environment) before the next tagged release.

---

## Dependency Advisory — esbuild < 0.28.1 (2026-07-21)

**Files:** `package.json`, `package-lock.json`. **No library code changes** — esbuild is a development-only transitive dependency (via `tsup` and `vite`); nothing ships in `dist/`.

**Issue:** Dependabot alert #9 (low severity): esbuild >= 0.27.3, < 0.28.1 allows arbitrary file read when running the development server on Windows. The lockfile resolved esbuild 0.27.4. No Dependabot PR was possible because `tsup` pins `esbuild ^0.27.0`.

**Fix:** npm `overrides` entry forcing `esbuild ^0.28.1` tree-wide (same fix as `cycles-mcp-server`, 2026-07-21). `npm audit` reports 0 vulnerabilities. Remove the override once `tsup` moves its esbuild range to >= 0.28.

**Verified (2026-07-21):** build (tsup on esbuild 0.28.1), test suite with coverage (99.81% lines / 93.88% branches; 337 passed, 5 skipped) all pass.

---

## Release Pipeline Fix — Pin npm 11 in Publish Job (2026-07-21)

**Files:** `.github/workflows/ci.yml`. **No library changes.** `npm install -g npm@latest` in the publish job broke once `latest` became npm 12.0.1, which dropped Node 20 support (`EBADENGINE`) — discovered when it failed the cycles-mcp-server v0.4.0 publish. Pinned to `npm@11` (supports Node 20, satisfies the OIDC minimum of 11.5.1).
