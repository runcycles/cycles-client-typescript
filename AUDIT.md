# Cycles Protocol v0.1.23 — Client (TypeScript) Audit

**Date:** 2026-03-14
**Spec:** `cycles-protocol-v0.yaml` (OpenAPI 3.1.0, v0.1.23)
**Client:** `runcycles` (Node 20+ / native fetch / TypeScript 5)
**Server audit:** See `cycles-server/AUDIT.md` (all passing)

---

## Summary

| Category | Pass | Issues |
|----------|------|--------|
| Endpoints & HTTP Methods | 9/9 | 0 |
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
| `EventCreateResponse` | `eventCreateResponseFromWire()` | `status`, `event_id`, `balances` | PASS |
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
- Heartbeat-based TTL extension at `max(ttlMs / 2, 1000)` ms interval using `extend` endpoint
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
- `CyclesTransportError` wraps network-level failures with cause chain

---

## Verdict

The client is **fully protocol-conformant** with the Cycles Protocol v0.1.23 OpenAPI spec. All 9 endpoints, 6 request schemas, 10 response schemas, 5 enum types, and all nested object serializations match the spec exactly. Wire-format mappers correctly translate between camelCase TypeScript and snake_case JSON throughout. Auth headers, idempotency handling, subject validation, response header capture, and spec constraint validation all follow spec normative rules. No open issues.
