# Cycles Protocol v0.1.25 — Client (TypeScript) Audit

**Date:** 2026-07-10 (unreleased — `TENANT_CLOSED` error-code support per runtime spec v0.1.25.13 (`cycles-protocol-v0.yaml`, runcycles/cycles-protocol#125): `ErrorCode.TENANT_CLOSED` enum member, `TenantClosedError` class wired into `buildProtocolException` (invoked on the reservation-time paths of `withCycles`, lifecycle, and `reserveForStream`; commit-time client errors are handled/released internally and `StreamReservation.commit()` throws generic `CyclesError`, so typed protocol exceptions are reservation-time only), `CyclesProtocolError.isTenantClosed()` helper; exported from the package root. Purely additive; previously the unrecognized code produced a generic `CyclesProtocolError` with the raw `errorCode` string preserved and `isRetryable()` already false, while `errorCodeFromString` fell back to `ErrorCode.UNKNOWN` (which `isRetryableErrorCode` treats as retryable) — now typed and non-retryable on both paths. Vendored spec fixture intentionally untouched until the spec PR merges; the contract suite validates the fixture, not the client enum. New tests in `exceptions.test.ts`, `errors.test.ts`, `models.test.ts`. 324 tests pass at 98.42% statement / 99.63% line coverage (gate ≥95% lines); eslint + typecheck clean.),
2026-07-04 (v0.3.4 pending — fixes the `EventCreateResponse.charged` mapper drop found by the fleet audit (#134 item 1): the field was declared on the interface but `eventCreateResponseFromWire` never mapped it, so the effective charge on ALLOW_IF_AVAILABLE-capped events was silently lost. Two regression tests pin presence + absence. 319 tests pass at 98.4% statement / 99.62% line coverage. Remaining audit findings tracked in #134.),
2026-07-03 (integration-test-only, no version bump — the live-server "health check" test now probes the public `/actuator/health/readiness` endpoint instead of aggregate `/actuator/health`, which requires `X-Admin-API-Key` since cycles-server v0.1.25.45 and fails closed with 500 when the server has no admin key configured. Would have failed the org nightly Full-Stack Integration once the Python step ahead of it was fixed. No library code change.),
2026-05-22 (v0.3.3 — `expires_from`/`expires_to` and `finalized_from`/`finalized_to` ISO-8601 window-filter passthrough on `listReservations` per `cycles-protocol-v0.yaml` revision 2026-05-22; closes the TypeScript-client side of runcycles/cycles-server#162. No code change — `params?: Record<string, string>` already forwards arbitrary keys; added a regression test that pins all four new params URL-encoded on the wire. 317 tests pass at 98.4% statement / 99.62% line coverage.),
2026-05-21 (v0.3.2 — `from` / `to` ISO-8601 window-filter passthrough on `listReservations` per `cycles-protocol-v0.yaml` revision 2026-05-21; closes the TypeScript-client side of runcycles/cycles-server#159. No code change — `params?: Record<string, string>` already forwards arbitrary keys; added a regression test that pins the URL-encoded passthrough. 316 tests pass at 98.4% statement / 99.62% line coverage.),
2026-03-19 (updated), 2026-03-14 (initial)
**Spec:** `cycles-protocol-v0.yaml` (OpenAPI 3.1.0, v0.1.25)
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

Added `tests/contract.test.ts` — 90 automated tests that load the OpenAPI spec YAML and validate request/response fixtures against the actual JSON Schema definitions using Ajv:

- **Request schemas validated:** `DecisionRequest`, `ReservationCreateRequest`, `CommitRequest`, `EventCreateRequest` — valid bodies pass, missing required fields and additional properties are rejected
- **Response schemas validated:** `DecisionResponse`, `ReservationCreateResponse`, `CommitResponse`, `EventCreateResponse`, `ErrorResponse` — valid bodies pass, missing required fields and invalid enum values are rejected
- **Leaf object schemas validated:** `Amount`, `Subject`, `Action` — constraints (required fields, additionalProperties, minimum values, anyOf) enforced
- **Enum completeness verified:** `UnitEnum` has exactly `[USD_MICROCENTS, TOKENS, CREDITS, RISK_POINTS]`; `ErrorCode` has all 15 expected values
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
