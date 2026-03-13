# Test Coverage Analysis

## Current Coverage Summary

| File | Stmts | Branch | Funcs | Lines | Notes |
|------|-------|--------|-------|-------|-------|
| **config.ts** | 100% | 91.3% | 100% | 100% | Near-perfect |
| **constants.ts** | 100% | 100% | 100% | 100% | Complete |
| **context.ts** | 100% | 100% | 100% | 100% | Complete |
| **mappers.ts** | 98.4% | 94.9% | 100% | 100% | Near-perfect |
| **models.ts** | 100% | 100% | 100% | 100% | Complete |
| **response.ts** | 100% | 95.5% | 100% | 100% | Near-perfect |
| **validation.ts** | 100% | 100% | 100% | 100% | Complete |
| **withCycles.ts** | 100% | 100% | 100% | 100% | Complete |
| **client.ts** | 93.9% | 63.3% | 94.1% | 93.9% | Gaps in branching |
| **retry.ts** | 95.7% | 87.5% | 100% | 95.2% | Minor gap |
| **errors.ts** | 80.8% | 65% | 100% | 80.8% | **No dedicated test file** |
| **exceptions.ts** | 80.6% | 100% | 62.5% | 80.6% | Helper methods uncovered |
| **lifecycle.ts** | 74.8% | 63.8% | 72.2% | 76.4% | **Lowest coverage** |
| **streaming.ts** | 82.2% | 76.7% | 72.7% | 85.3% | Heartbeat/edge cases |
| **Overall** | **89.2%** | **81.8%** | **90.1%** | **89.8%** | |

---

## Recommended Improvements (Ranked by Impact)

### 1. `lifecycle.ts` — 74.8% statements, 63.8% branches (highest priority)

**Uncovered areas:**
- **`_handleCommit` error-code branches (lines 327-348):** The commit failure path handles several specific error codes (`RESERVATION_FINALIZED`, `RESERVATION_EXPIRED`, `IDEMPOTENCY_MISMATCH`, generic client errors), but only the 5xx/transport retry path is tested. Each error-code branch should have its own test case.
- **`_startHeartbeat` (lines 363-405):** The heartbeat timer, extend call, context update (`ctx.expiresAtMs`), and error-swallowing are never exercised. Tests should use fake timers to verify:
  - Heartbeat fires at `ttlMs / 2` intervals.
  - Successful extend updates `ctx.expiresAtMs`.
  - Failed extend doesn't crash.
  - Stopping the heartbeat clears the timer.
- **`evaluateActual` fallback paths (lines 67-85):** The `useEstimateIfActualNotProvided = false` branch (which throws) and the callable `actual` function path are untested.
- **`buildReservationBody` with `gracePeriodMs` and `dryRun` flags (lines 136-142):** These wire-format fields are covered by other tests indirectly but lack targeted unit assertions.
- **Commit with metrics and metadata (lines 282-295):** The code that auto-sets `latencyMs` and passes `ctx.commitMetadata` is untested.

**Proposed tests:**
```
- _handleCommit: RESERVATION_FINALIZED silently succeeds
- _handleCommit: RESERVATION_EXPIRED silently succeeds
- _handleCommit: IDEMPOTENCY_MISMATCH silently succeeds
- _handleCommit: other client error triggers release
- _handleCommit: network exception schedules retry
- heartbeat extends reservation periodically (fake timers)
- heartbeat updates ctx.expiresAtMs on success
- heartbeat swallows extend failures
- evaluateActual with callable actual function
- evaluateActual throws when actual is undefined and fallback disabled
- commit includes context metrics and metadata
- commit auto-sets latencyMs when not provided
```

---

### 2. `errors.ts` — 80.8% statements, 65% branches (no dedicated test file)

**Uncovered areas:**
- **Fallback path when `getErrorResponse()` returns null (lines 37-44):** The code falls back to reading `response.getBodyAttribute("error")` and `response.errorMessage` directly, but this path has no test coverage.
- **`reasonCode` defaulting to `errorCode` (line 48-49):** When `reason_code` isn't in the response body, the code falls back to the error code.
- **`retry_after_ms` parsing (line 52-53):** Number conversion of the raw retry value is untested.
- **Switch cases for `OVERDRAFT_LIMIT_EXCEEDED`, `DEBT_OUTSTANDING`, `RESERVATION_EXPIRED`, `RESERVATION_FINALIZED` (lines 68-74):** Only `BUDGET_EXCEEDED` and the default case are exercised by other tests.

**Proposed tests (new `tests/errors.test.ts`):**
```
- builds BudgetExceededError for BUDGET_EXCEEDED code
- builds OverdraftLimitExceededError for OVERDRAFT_LIMIT_EXCEEDED code
- builds DebtOutstandingError for DEBT_OUTSTANDING code
- builds ReservationExpiredError for RESERVATION_EXPIRED code
- builds ReservationFinalizedError for RESERVATION_FINALIZED code
- builds generic CyclesProtocolError for unknown codes
- falls back to body "error" attribute when getErrorResponse is null
- parses retry_after_ms from response body
- defaults reasonCode to errorCode when reason_code absent
- extracts details from error response
```

---

### 3. `streaming.ts` — 82.2% statements, 76.7% branches

**Uncovered areas:**
- **Heartbeat tick loop (lines 197-215):** The internal `startHeartbeat` → `tick()` → `extendReservation` chain is never triggered in tests. Same pattern as lifecycle.ts but needs independent coverage.
- **Missing `reservationId` after successful response (line 178-183):** The guard that throws when `reservation_id` is absent from a success response is untested.
- **Commit with metrics and metadata (lines 242-247):** Passing `metrics` and `metadata` through to the commit body isn't verified.
- **Release error swallowing (lines 258-260):** The catch block in `release()` that silently swallows errors isn't tested.

**Proposed tests:**
```
- heartbeat extends reservation on interval (fake timers)
- heartbeat swallows extend failures gracefully
- throws when reservation_id missing from success response
- commit includes metrics in wire format
- commit includes metadata
- release swallows client errors silently
```

---

### 4. `exceptions.ts` — 80.6% statements, 62.5% functions

**Uncovered areas:**
- **Helper methods on `CyclesProtocolError` (lines 44-64):** The methods `isOverdraftLimitExceeded()`, `isDebtOutstanding()`, `isReservationExpired()`, `isReservationFinalized()`, `isIdempotencyMismatch()`, and `isUnitMismatch()` are never called in tests.

**Proposed tests:**
```
- isOverdraftLimitExceeded returns true for matching code
- isDebtOutstanding returns true for matching code
- isReservationExpired returns true for matching code
- isReservationFinalized returns true for matching code
- isIdempotencyMismatch returns true for matching code
- isUnitMismatch returns true for matching code
- all helpers return false for non-matching codes
```

---

### 5. `client.ts` — 93.9% statements, 63.3% branches

**Uncovered areas:**
- **`Symbol.asyncDispose` (line 195-198):** The `await using` protocol method is never tested.
- **Non-JSON response body parsing (line 206-208):** The catch in `_handleResponse` that handles non-JSON responses is untested.
- **Idempotency key header extraction (line 143-146):** The branch where `idempotency_key` is missing or not a string from the request body is untested.

**Proposed tests:**
```
- asyncDispose is callable and resolves
- handles non-JSON response body gracefully
- omits idempotency header when key is not a string
- sets idempotency header from wire-format body
```

---

### 6. Missing Test Category: `errors.ts` Integration with Exception Hierarchy

There is no `tests/errors.test.ts` file at all. The `buildProtocolException()` function — which is the central error-mapping utility used by both `lifecycle.ts` and `streaming.ts` — is only exercised indirectly through those callers. Given its importance as the single source of truth for error-code-to-exception mapping, it deserves dedicated unit tests.

---

## Summary of Gaps by Priority

| Priority | Module | Current Lines | Gap | Effort |
|----------|--------|--------------|-----|--------|
| P0 | `errors.ts` | 80.8% | No test file; all 5 error-code switch cases | Small |
| P0 | `lifecycle.ts` | 76.4% | `_handleCommit` branches, heartbeat, actual evaluation | Medium |
| P1 | `streaming.ts` | 85.3% | Heartbeat, missing ID guard, metrics passthrough | Medium |
| P1 | `exceptions.ts` | 80.6% | 6 untested helper methods | Small |
| P2 | `client.ts` | 93.9% | asyncDispose, non-JSON body, idempotency header edge | Small |

Addressing P0 and P1 items would bring overall line coverage from **89.8% to ~96%+** and branch coverage from **81.8% to ~92%+**.
