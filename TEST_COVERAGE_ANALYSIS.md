# Test Coverage Analysis

## Current Coverage Summary (Post-Improvement)

| File | Stmts | Branch | Funcs | Lines | Notes |
|------|-------|--------|-------|-------|-------|
| **client.ts** | 97.9% | 80% | 100% | 97.9% | Minor gap: header extraction loop |
| **config.ts** | 100% | 91.3% | 100% | 100% | Near-perfect |
| **constants.ts** | 100% | 100% | 100% | 100% | Complete |
| **context.ts** | 100% | 100% | 100% | 100% | Complete |
| **errors.ts** | 100% | 95% | 100% | 100% | Near-perfect |
| **exceptions.ts** | 100% | 100% | 100% | 100% | Complete |
| **lifecycle.ts** | 96.9% | 89.5% | 100% | 99.2% | Minor gap: dimensions branch |
| **mappers.ts** | 98.4% | 94.9% | 100% | 100% | Near-perfect |
| **models.ts** | 100% | 100% | 100% | 100% | Complete |
| **response.ts** | 100% | 95.5% | 100% | 100% | Near-perfect |
| **retry.ts** | 95.7% | 87.5% | 100% | 95.2% | Minor gap |
| **streaming.ts** | 96.2% | 91.5% | 100% | 100% | Near-perfect |
| **validation.ts** | 100% | 100% | 100% | 100% | Complete |
| **withCycles.ts** | 100% | 100% | 100% | 100% | Complete |
| **Overall** | **98.2%** | **92.4%** | **100%** | **99.4%** | |

---

## Improvement Summary

Coverage improved from **89.8% → 99.4% lines** and **81.8% → 92.4% branches** across 5 commits:

### Tests added (212 total, up from ~160)

**`tests/errors.test.ts`** (new file — 12 tests)
- All 5 error-code switch cases: `BUDGET_EXCEEDED`, `OVERDRAFT_LIMIT_EXCEEDED`, `DEBT_OUTSTANDING`, `RESERVATION_EXPIRED`, `RESERVATION_FINALIZED`
- Generic `CyclesProtocolError` for unknown codes
- Fallback path when `getErrorResponse()` returns null (body missing `request_id`)
- `retry_after_ms` parsing, `reasonCode` defaulting, transport error handling

**`tests/lifecycle.test.ts`** (~17 new tests)
- `_handleCommit` error-code branches: `RESERVATION_FINALIZED`, `RESERVATION_EXPIRED`, `IDEMPOTENCY_MISMATCH`, generic client error, network exception with retry scheduling
- Heartbeat with fake timers: fires at correct interval, swallows failures
- `evaluateActual` paths: callable, static, missing with fallback disabled
- Context metrics/metadata: auto-set `latencyMs`, `commitMetadata` passthrough
- Missing `reservation_id` guard, dry-run DENY
- Raw body fallback regression test

**`tests/streaming.test.ts`** (~12 new tests)
- Heartbeat extend on interval and failure swallowing (fake timers)
- Missing `reservation_id` guard
- Commit with metrics/metadata, empty metrics omission
- Release error swallowing, default reason
- Commit recovery: retry after transport failure, `CyclesError` on non-success HTTP, release as fallback after commit failure

**`tests/exceptions.test.ts`** (8 new tests)
- All 6 previously uncovered helper methods: `isOverdraftLimitExceeded`, `isDebtOutstanding`, `isReservationExpired`, `isReservationFinalized`, `isIdempotencyMismatch`, `isUnitMismatch`
- "All return false for non-matching code" coverage

**`tests/client.test.ts`** (4 new tests)
- `asyncDispose` resolves without error
- Non-JSON response body handling (success + error paths)
- Idempotency header omission when key missing
- GET transport error

---

## Bugs Found and Fixed

### Bug 1: `lifecycle.ts` `_handleCommit` — malformed 4xx body bypass

When the server returns 4xx with a body missing `request_id`, `getErrorResponse()` returns `undefined`, leaving `errorCode` as `undefined`. Named error checks (`RESERVATION_FINALIZED`, etc.) never match, falling through to release with reason `"commit_rejected_undefined"`.

**Fix:** Added raw body fallback — extract error code via `getBodyAttribute("error")` when structured error response is unavailable. Changed release reason to use `"unknown"` instead of stringifying `undefined`.

### Bug 2: `streaming.ts` `commit()` — irrecoverable state on failure

Setting `finalized = true` before the commit API call meant that if commit threw, the handle was permanently stuck — no retry, no release possible. The response status also wasn't checked.

**Fix:** Added `response.isSuccess` check. Added catch block that resets `finalized = false` so the caller can retry or fall back to release. The heartbeat is NOT restarted to avoid spawning duplicate heartbeat chains (an old in-flight extend's `.finally→tick()` could race with a new `startHeartbeat()` call).

### Bug 3: Examples — wire-format key mismatch

`examples/basic-usage.ts` passed camelCase keys (`idempotencyKey`, `ttlMs`, `tokensInput`) directly to `CyclesClient`, but the client sends bodies as-is without key conversion. The server expects snake_case (`idempotency_key`, `ttl_ms`, `tokens_input`).

**Fix:** Changed all keys to snake_case wire format.

### Bug 4: Examples — misleading `dispose()` usage

`examples/vercel-ai-sdk/` called `dispose()` in `finally` blocks after `commit()` and `release()`, but both methods already stop the heartbeat. The example README also claimed `dispose()` should "always [be called] in `finally`", contradicting the main README's correct guidance that it's for startup failures only.

**Fix:** Removed redundant `dispose()` calls and updated documentation.

---

## Remaining Gaps (Low Priority)

| File | Uncovered | Description |
|------|-----------|-------------|
| `client.ts:47` | Branch | Response header extraction loop — header not present in mock |
| `config.ts:86-90` | Branch | `fromEnv()` env var parsing edge cases |
| `errors.ts:33` | Branch | Minor branch in error construction |
| `lifecycle.ts:122` | Line | `dimensions` field in `buildReservationBody` |
| `mappers.ts:86,187` | Branch | Optional field mapping branches |
| `response.ts:67` | Branch | Edge case in response attribute access |
| `retry.ts:55` | Line | Retry edge case |
| `streaming.ts:198-204,252` | Branch | Heartbeat interval edge, release reason branch |

These are all minor edge cases in branches that would provide diminishing returns to cover.
