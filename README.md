# Cycles TypeScript Client

TypeScript client for the [Cycles](https://runcycles.io) budget-management protocol — govern spend on AI calls, API usage, and any metered resource.

Cycles lets you set budgets, reserve capacity before expensive operations, and track actual usage. This client handles the full reservation lifecycle: reserve budget up front, execute your work, then commit or release — with automatic heartbeats, retries, and typed error handling.

## Requirements

- **Node.js 20+** (uses built-in `fetch` and `AsyncLocalStorage`)
- **TypeScript 5+** (for type definitions; optional — works with plain JavaScript)

## Installation

```bash
npm install runcycles
```

## Quick Start

### 1. Higher-order function (recommended)

Wrap any async function with `withCycles` to automatically reserve, execute, and commit:

```typescript
import { CyclesClient, CyclesConfig, withCycles, getCyclesContext } from "runcycles";

const config = new CyclesConfig({
  baseUrl: "http://localhost:7878",
  apiKey: "your-api-key",
  tenant: "acme",
});
const client = new CyclesClient(config);

const callLlm = withCycles(
  {
    estimate: (prompt: string, tokens: number) => tokens * 10,
    actual: (result: string) => result.length * 5,
    actionKind: "llm.completion",
    actionName: "gpt-4",
    client,
  },
  async (prompt: string, tokens: number) => {
    const ctx = getCyclesContext();
    if (ctx?.caps) {
      tokens = Math.min(tokens, ctx.caps.maxTokens ?? tokens);
    }

    const result = `Response to: ${prompt}`;

    if (ctx) {
      ctx.metrics = { tokensInput: tokens, tokensOutput: result.length };
    }

    return result;
  },
);

const result = await callLlm("Hello", 100);
```

**What happens:** `withCycles` reserves budget before calling your function, runs it inside an async context (so `getCyclesContext()` works), commits the actual cost on success, or releases the reservation on failure. A background heartbeat keeps the reservation alive.

### 2. Streaming adapter

For LLM streaming where usage is only known after the stream finishes:

```typescript
import { CyclesClient, CyclesConfig, reserveForStream } from "runcycles";

const config = new CyclesConfig({
  baseUrl: "http://localhost:7878",
  apiKey: "your-api-key",
  tenant: "acme",
});
const client = new CyclesClient(config);

let handle;
try {
  handle = await reserveForStream({
    client,
    estimate: 5000,
    unit: "USD_MICROCENTS",
    actionKind: "llm.completion",
    actionName: "gpt-4o",
  });
} catch (err) {
  // Reservation denied (BudgetExceededError, etc.) — no cleanup needed
  throw err;
}

try {
  // Start streaming (e.g. Vercel AI SDK's streamText)
  const stream = streamText({
    model: openai("gpt-4o"),
    messages,
    onFinish: async ({ usage }) => {
      const actualCost = (usage.promptTokens + usage.completionTokens) * 3;
      // commit() automatically stops the heartbeat
      await handle.commit(actualCost, {
        tokensInput: usage.promptTokens,
        tokensOutput: usage.completionTokens,
      });
    },
  });

  return stream.toDataStreamResponse();
} catch (err) {
  // Stream startup failed — release and stop heartbeat
  await handle.release("stream_error");
  throw err;
}
```

The handle is **once-only and race-safe**: in streaming code, multiple terminal paths can fire concurrently (onFinish, error handler, abort signal). Only the first terminal call wins:
- `commit()` throws `CyclesError` if already finalized (dropping a commit silently hides bugs)
- `release()` is a silent no-op if already finalized (best-effort by design)
- `dispose()` stops the heartbeat only, for startup failures before streaming begins
- `handle.finalized` — check whether the handle has been finalized

### 3. Programmatic client

Use `CyclesClient` directly for full control. The client operates on wire-format (snake_case) JSON. Use typed mappers for camelCase convenience, or pass raw snake_case objects:

```typescript
import {
  CyclesClient,
  CyclesConfig,
  reservationCreateRequestToWire,
  reservationCreateResponseFromWire,
  commitRequestToWire,
  commitResponseFromWire,
} from "runcycles";

const config = new CyclesConfig({ baseUrl: "http://localhost:7878", apiKey: "your-api-key" });
const client = new CyclesClient(config);

// 1. Reserve budget (using typed request mapper)
const response = await client.createReservation(
  reservationCreateRequestToWire({
    idempotencyKey: "req-001",
    subject: { tenant: "acme", agent: "support-bot" },
    action: { kind: "llm.completion", name: "gpt-4" },
    estimate: { unit: "USD_MICROCENTS", amount: 500_000 },
    ttlMs: 30_000,
  }),
);

if (response.isSuccess) {
  // Parse typed response
  const parsed = reservationCreateResponseFromWire(response.body!);

  // 2. Do work ...

  // 3. Commit actual usage (using typed request mapper)
  const commitResp = await client.commitReservation(
    parsed.reservationId!,
    commitRequestToWire({
      idempotencyKey: "commit-001",
      actual: { unit: "USD_MICROCENTS", amount: 420_000 },
      metrics: { tokensInput: 1200, tokensOutput: 800 },
    }),
  );

  if (commitResp.isSuccess) {
    const commit = commitResponseFromWire(commitResp.body!);
    console.log(`Charged: ${commit.charged.amount}, Released: ${commit.released?.amount}`);
  }
}
```

You can also pass raw snake_case objects directly without mappers:

```typescript
const response = await client.createReservation({
  idempotency_key: "req-001",
  subject: { tenant: "acme", agent: "support-bot" },
  action: { kind: "llm.completion", name: "gpt-4" },
  estimate: { unit: "USD_MICROCENTS", amount: 500_000 },
  ttl_ms: 30_000,
});
```

### Which pattern to use?

| Pattern | Use when |
|---------|----------|
| `withCycles` | You have an async function that returns a result — the lifecycle is fully automatic |
| `reserveForStream` | You're streaming (e.g., LLM streaming) and usage is known only after the stream finishes |
| `CyclesClient` | You need full control over the reservation lifecycle, or are building custom integrations |

## Configuration

### Constructor options

```typescript
new CyclesConfig({
  // Required
  baseUrl: "http://localhost:7878",
  apiKey: "your-api-key",

  // Default subject fields (applied to all requests unless overridden)
  tenant: "acme",
  workspace: "prod",
  app: "chat",
  workflow: "refund-flow",
  agent: "planner",
  toolset: "search-tools",

  // Timeouts (ms) — summed into a single fetch AbortSignal timeout
  connectTimeout: 2_000,   // default: 2000
  readTimeout: 5_000,      // default: 5000

  // Commit retry (exponential backoff for failed commits)
  retryEnabled: true,       // default: true
  retryMaxAttempts: 5,      // default: 5
  retryInitialDelay: 500,   // default: 500 (ms)
  retryMultiplier: 2.0,     // default: 2.0
  retryMaxDelay: 30_000,    // default: 30000 (ms)
});
```

> **Timeout note:** Node's built-in `fetch` does not distinguish connection timeout from read timeout. `connectTimeout` and `readTimeout` are summed into a single `AbortSignal.timeout()` value (default: 7000ms total) that caps the entire request duration.

### Environment variables

```typescript
import { CyclesConfig } from "runcycles";

const config = CyclesConfig.fromEnv();
```

`fromEnv()` reads these environment variables (all prefixed with `CYCLES_` by default):

| Variable | Required | Description |
|----------|----------|-------------|
| `CYCLES_BASE_URL` | Yes | Cycles server URL |
| `CYCLES_API_KEY` | Yes | API key for authentication |
| `CYCLES_TENANT` | No | Default tenant |
| `CYCLES_WORKSPACE` | No | Default workspace |
| `CYCLES_APP` | No | Default app |
| `CYCLES_WORKFLOW` | No | Default workflow |
| `CYCLES_AGENT` | No | Default agent |
| `CYCLES_TOOLSET` | No | Default toolset |
| `CYCLES_CONNECT_TIMEOUT` | No | Connect timeout in ms (default: 2000) |
| `CYCLES_READ_TIMEOUT` | No | Read timeout in ms (default: 5000) |
| `CYCLES_RETRY_ENABLED` | No | Enable commit retry (default: true) |
| `CYCLES_RETRY_MAX_ATTEMPTS` | No | Max retry attempts (default: 5) |
| `CYCLES_RETRY_INITIAL_DELAY` | No | Initial retry delay in ms (default: 500) |
| `CYCLES_RETRY_MULTIPLIER` | No | Backoff multiplier (default: 2.0) |
| `CYCLES_RETRY_MAX_DELAY` | No | Max retry delay in ms (default: 30000) |

Custom prefix: `CyclesConfig.fromEnv("MYAPP_")` reads `MYAPP_BASE_URL`, `MYAPP_API_KEY`, etc.

### Default client / config

Instead of passing `client` to every `withCycles` call, set a module-level default:

```typescript
import { CyclesConfig, setDefaultConfig, setDefaultClient, CyclesClient, withCycles } from "runcycles";

// Option 1: Set a config (client created lazily)
setDefaultConfig(new CyclesConfig({ baseUrl: "http://localhost:7878", apiKey: "your-key", tenant: "acme" }));

// Option 2: Set an explicit client
setDefaultClient(new CyclesClient(new CyclesConfig({ baseUrl: "http://localhost:7878", apiKey: "your-key" })));

// Now withCycles works without client
const guarded = withCycles({ estimate: 1000 }, async () => "hello");
```

## `withCycles` Options

The `WithCyclesConfig` interface controls the lifecycle behavior:

```typescript
interface WithCyclesConfig {
  // Cost estimation — required
  estimate: number | ((...args) => number);  // Estimated cost (static or computed from args)

  // Actual cost — optional (defaults to estimate if not provided)
  actual?: number | ((result) => number);    // Actual cost (static or computed from result)
  useEstimateIfActualNotProvided?: boolean;  // Default: true — use estimate as actual

  // Action identification
  actionKind?: string;   // e.g. "llm.completion" (default: "unknown")
  actionName?: string;   // e.g. "gpt-4" (default: "unknown")
  actionTags?: string[]; // Optional tags for categorization

  // Budget unit
  unit?: string;  // default: "USD_MICROCENTS"

  // Reservation settings
  ttlMs?: number;          // Time-to-live in ms (default: 60000, range: 1000–86400000)
  gracePeriodMs?: number;  // Grace period in ms (range: 0–60000)
  overagePolicy?: string;  // "REJECT" (default), "ALLOW_IF_AVAILABLE", "ALLOW_WITH_OVERDRAFT"
  dryRun?: boolean;        // Shadow mode — evaluates budget without executing

  // Subject fields (override config defaults)
  tenant?: string;
  workspace?: string;
  app?: string;
  workflow?: string;
  agent?: string;
  toolset?: string;
  dimensions?: Record<string, string>;  // Custom key-value dimensions

  // Client
  client?: CyclesClient;  // Override the default client
}
```

## Context Access

Inside a `withCycles`-guarded function, access the active reservation via `getCyclesContext()`:

```typescript
import { getCyclesContext } from "runcycles";

const guarded = withCycles({ estimate: 1000, client }, async () => {
  const ctx = getCyclesContext();

  // Read reservation details (read-only)
  ctx?.reservationId;    // Server-assigned reservation ID
  ctx?.estimate;         // The estimated amount
  ctx?.decision;         // "ALLOW" or "ALLOW_WITH_CAPS"
  ctx?.caps;             // Soft-landing caps (maxTokens, toolAllowlist, etc.)
  ctx?.expiresAtMs;      // Reservation expiry (updated by heartbeat)
  ctx?.affectedScopes;   // Budget scopes affected
  ctx?.scopePath;        // Scope path for this reservation
  ctx?.reserved;         // Amount reserved
  ctx?.balances;         // Balance snapshots

  // Set metrics (included in the commit)
  if (ctx) {
    ctx.metrics = { tokensInput: 50, tokensOutput: 200, modelVersion: "gpt-4o" };
    ctx.commitMetadata = { requestId: "abc", region: "us-east-1" };
  }

  return "result";
});
```

The context uses `AsyncLocalStorage`, so it's available in any nested async call within the guarded function.

**Latency tracking:** If `ctx.metrics.latencyMs` is not set, `withCycles` automatically sets it to the execution time of the guarded function.

## Error Handling

### With `withCycles` or `reserveForStream`

Protocol errors are thrown as typed exceptions:

```typescript
import {
  withCycles,
  BudgetExceededError,
  CyclesProtocolError,
  CyclesTransportError,
} from "runcycles";

const guarded = withCycles({ estimate: 1000, client }, async () => "result");

try {
  await guarded();
} catch (err) {
  if (err instanceof BudgetExceededError) {
    console.log("Budget exhausted — degrade or queue");
  } else if (err instanceof CyclesProtocolError) {
    // Use helper methods for cleaner checks
    if (err.isBudgetExceeded()) { /* ... */ }
    if (err.isOverdraftLimitExceeded()) { /* ... */ }
    if (err.isDebtOutstanding()) { /* ... */ }
    if (err.isReservationExpired()) { /* ... */ }
    if (err.isReservationFinalized()) { /* ... */ }
    if (err.isIdempotencyMismatch()) { /* ... */ }
    if (err.isUnitMismatch()) { /* ... */ }

    // Retry handling
    if (err.isRetryable() && err.retryAfterMs) {
      console.log(`Retry after ${err.retryAfterMs}ms`);
    }

    // Error details
    console.log(err.errorCode);   // e.g. "BUDGET_EXCEEDED"
    console.log(err.reasonCode);  // Server-provided reason
    console.log(err.requestId);   // For support/debugging
    console.log(err.details);     // Additional error context
    console.log(err.status);      // HTTP status code
  } else if (err instanceof CyclesTransportError) {
    console.log("Network error:", err.message, err.cause);
  }
}
```

### Exception hierarchy

| Exception | When |
|-----------|------|
| `CyclesError` | Base for all Cycles errors |
| `CyclesProtocolError` | Server returned a protocol-level error |
| `BudgetExceededError` | Budget insufficient for the reservation |
| `OverdraftLimitExceededError` | Debt exceeds the overdraft limit |
| `DebtOutstandingError` | Outstanding debt blocks new reservations |
| `ReservationExpiredError` | Operating on an expired reservation |
| `ReservationFinalizedError` | Operating on an already-committed/released reservation |
| `CyclesTransportError` | Network-level failure (connection, DNS, timeout) |

### With `CyclesClient` (programmatic)

The client returns `CyclesResponse` instead of throwing:

```typescript
const response = await client.createReservation({ /* ... */ });

if (response.isTransportError) {
  console.log("Network error:", response.errorMessage);
  console.log("Underlying error:", response.transportError);
} else if (!response.isSuccess) {
  console.log(`HTTP ${response.status}: ${response.errorMessage}`);
  console.log(`Request ID: ${response.requestId}`);

  // Parse structured error
  const err = response.getErrorResponse();
  if (err) {
    console.log(`Error code: ${err.error}, Message: ${err.message}`);
    console.log(`Details:`, err.details);
  }
}
```

## Response Metadata

Every `CyclesResponse` exposes server headers:

```typescript
const response = await client.createReservation({ /* ... */ });

response.requestId;          // X-Request-Id — for tracing/debugging
response.rateLimitRemaining; // X-RateLimit-Remaining — requests left in window
response.rateLimitReset;     // X-RateLimit-Reset — epoch seconds when window resets
response.cyclesTenant;       // X-Cycles-Tenant — resolved tenant

// Status checks
response.isSuccess;       // 2xx
response.isClientError;   // 4xx
response.isServerError;   // 5xx
response.isTransportError; // Network failure (status = -1)
```

## API Reference

### `CyclesClient` Methods

All methods return `Promise<CyclesResponse>`.

| Method | Description |
|--------|-------------|
| `createReservation(request)` | Reserve budget before an operation |
| `commitReservation(reservationId, request)` | Commit actual usage after completion |
| `releaseReservation(reservationId, request)` | Release unused reservation |
| `extendReservation(reservationId, request)` | Extend reservation TTL (heartbeat) |
| `decide(request)` | Preflight budget check without creating a reservation |
| `createEvent(request)` | Record spend directly without a reservation (direct debit) |
| `listReservations(params?)` | List reservations with optional filters |
| `getReservation(reservationId)` | Get a single reservation's details |
| `getBalances(params)` | Query budget balances (requires at least one subject filter) |

### `StreamReservation` Handle

Returned by `reserveForStream()`:

| Property/Method | Description |
|-----------------|-------------|
| `reservationId` | Server-assigned reservation ID |
| `decision` | Budget decision (`ALLOW` or `ALLOW_WITH_CAPS`) |
| `caps` | Soft-landing caps, if any |
| `finalized` | `true` after any terminal call |
| `commit(actual, metrics?, metadata?)` | Commit actual usage; throws if already finalized |
| `release(reason?)` | Release reservation; no-op if already finalized |
| `dispose()` | Stop heartbeat only, for startup failures |

## Preflight Checks (decide)

Check if a budget would allow an operation without creating a reservation:

```typescript
import { decisionRequestToWire, decisionResponseFromWire } from "runcycles";

const response = await client.decide(
  decisionRequestToWire({
    idempotencyKey: "decide-001",
    subject: { tenant: "acme" },
    action: { kind: "llm.completion", name: "gpt-4" },
    estimate: { unit: "USD_MICROCENTS", amount: 500_000 },
  }),
);

if (response.isSuccess) {
  const parsed = decisionResponseFromWire(response.body!);
  console.log(parsed.decision); // "ALLOW", "ALLOW_WITH_CAPS", or "DENY"
  if (parsed.caps) {
    console.log(`Max tokens: ${parsed.caps.maxTokens}`);
  }
}
```

Use `decide()` for lightweight checks before committing to work (e.g., showing a user "you have budget remaining" in a UI), or when you want to inspect caps before starting. Unlike `createReservation`, it doesn't hold any budget.

## Events (Direct Debit)

Record spend without a prior reservation (returns HTTP 201):

```typescript
import { eventCreateRequestToWire, eventCreateResponseFromWire } from "runcycles";

const response = await client.createEvent(
  eventCreateRequestToWire({
    idempotencyKey: "evt-001",
    subject: { tenant: "acme" },
    action: { kind: "api.call", name: "geocode" },
    actual: { unit: "USD_MICROCENTS", amount: 1_500 },
    overagePolicy: "ALLOW_IF_AVAILABLE",
    metrics: { latencyMs: 120 },
    clientTimeMs: Date.now(),
    metadata: { region: "us-east-1" },
  }),
);

if (response.isSuccess) {
  const parsed = eventCreateResponseFromWire(response.body!);
  console.log(`Event ID: ${parsed.eventId}, Status: ${parsed.status}`);
}
```

Use events for fast, low-value operations where the reserve/commit overhead isn't justified (e.g., simple API calls, cache lookups, tool invocations with known costs).

## Querying

### Balances

At least one subject filter is required:

```typescript
import { balanceResponseFromWire } from "runcycles";

const response = await client.getBalances({ tenant: "acme" });
if (response.isSuccess) {
  const parsed = balanceResponseFromWire(response.body!);
  for (const balance of parsed.balances) {
    console.log(`${balance.scopePath}: remaining=${balance.remaining.amount}`);
    console.log(`  reserved=${balance.reserved?.amount}, spent=${balance.spent?.amount}`);
    console.log(`  allocated=${balance.allocated?.amount}`);
    if (balance.isOverLimit) {
      console.log(`  OVER LIMIT — debt: ${balance.debt?.amount}, limit: ${balance.overdraftLimit?.amount}`);
    }
  }
  // Pagination
  if (parsed.hasMore) {
    const next = await client.getBalances({ tenant: "acme", cursor: parsed.nextCursor! });
    // ...
  }
}
```

Query filters: `tenant`, `workspace`, `app`, `workflow`, `agent`, `toolset`, `include_children`, `limit`, `cursor`.

### Reservations

```typescript
import { reservationListResponseFromWire, reservationDetailFromWire } from "runcycles";

// List reservations (filters: tenant, workspace, app, workflow, agent, toolset, status, idempotency_key, limit, cursor)
const list = await client.listReservations({ tenant: "acme", status: "ACTIVE" });
if (list.isSuccess) {
  const parsed = reservationListResponseFromWire(list.body!);
  for (const r of parsed.reservations) {
    console.log(`${r.reservationId}: ${r.status} — ${r.reserved.amount} ${r.reserved.unit}`);
  }
  if (parsed.hasMore) {
    const next = await client.listReservations({ tenant: "acme", cursor: parsed.nextCursor! });
  }
}

// Get a specific reservation
const detail = await client.getReservation("r-123");
if (detail.isSuccess) {
  const parsed = reservationDetailFromWire(detail.body!);
  console.log(`Status: ${parsed.status}`);
  console.log(`Reserved: ${parsed.reserved.amount}, Committed: ${parsed.committed?.amount}`);
  console.log(`Created: ${parsed.createdAtMs}, Expires: ${parsed.expiresAtMs}`);
  console.log(`Finalized: ${parsed.finalizedAtMs}`);
}
```

### Release and Extend

```typescript
import { releaseRequestToWire, releaseResponseFromWire } from "runcycles";
import { reservationExtendRequestToWire, reservationExtendResponseFromWire } from "runcycles";

// Release a reservation
const releaseResp = await client.releaseReservation(
  "r-123",
  releaseRequestToWire({ idempotencyKey: "rel-001", reason: "user_cancelled" }),
);
if (releaseResp.isSuccess) {
  const parsed = releaseResponseFromWire(releaseResp.body!);
  console.log(`Released: ${parsed.released.amount}`);
}

// Extend a reservation TTL (heartbeat)
const extendResp = await client.extendReservation(
  "r-123",
  reservationExtendRequestToWire({ idempotencyKey: "ext-001", extendByMs: 30_000 }),
);
if (extendResp.isSuccess) {
  const parsed = reservationExtendResponseFromWire(extendResp.body!);
  console.log(`New expiry: ${parsed.expiresAtMs}`);
}
```

## Dry Run (Shadow Mode)

Test budget evaluation without executing the guarded function:

```typescript
import type { DryRunResult } from "runcycles";

const guarded = withCycles(
  { estimate: 1000, dryRun: true, client },
  async () => "result",
);

const dryResult = await guarded() as unknown as DryRunResult;
console.log(dryResult.decision);      // "ALLOW", "ALLOW_WITH_CAPS", or throws on "DENY"
console.log(dryResult.caps);          // Caps if ALLOW_WITH_CAPS
console.log(dryResult.reserved);      // Amount that would be reserved
console.log(dryResult.affectedScopes);
console.log(dryResult.balances);
```

## Retry Behavior

When a commit fails due to a transport error or server error (5xx), the client automatically schedules background retries using exponential backoff:

- **Retries are fire-and-forget** — your guarded function returns immediately; the commit is retried in the background
- **Backoff formula:** `min(initialDelay * multiplier^attempt, maxDelay)` — defaults to 500ms, 1s, 2s, 4s, 8s
- **Non-retryable errors** (4xx client errors) stop retries immediately
- **Already-finalized reservations** (`RESERVATION_FINALIZED`, `RESERVATION_EXPIRED`) are accepted silently
- Retries only apply to commits from `withCycles` — the streaming adapter and programmatic client do not auto-retry

Configure via `CyclesConfig`:

```typescript
new CyclesConfig({
  // ...
  retryEnabled: false,        // disable retries entirely
  retryMaxAttempts: 3,        // fewer attempts
  retryInitialDelay: 1000,    // start slower
});
```

## Heartbeat

Both `withCycles` and `reserveForStream` start an automatic heartbeat that extends the reservation TTL while your work runs:

- **Interval:** `max(ttlMs / 2, 1000ms)` — e.g., a 60s TTL heartbeats every 30s
- **Extension amount:** equals the full `ttlMs` each time
- **Best-effort:** heartbeat failures are silently ignored
- **Auto-stop:** the heartbeat stops when the reservation is committed, released, or disposed

## Validation

The client validates inputs before sending requests:

| Field | Constraint | Error |
|-------|-----------|-------|
| `subject` | At least one of: tenant, workspace, app, workflow, agent, toolset | `"Subject must have at least one standard field"` |
| `estimate` | Must be >= 0 | `"estimate must be non-negative"` |
| `ttlMs` | 1,000 – 86,400,000 ms (1s – 24h) | `"ttl_ms must be between 1000 and 86400000"` |
| `gracePeriodMs` | 0 – 60,000 ms (0 – 60s) | `"grace_period_ms must be between 0 and 60000"` |
| `extendByMs` | 1 – 86,400,000 ms | `"extend_by_ms must be between 1 and 86400000"` |

## Wire-Format Mappers

The client sends snake_case JSON on the wire. Typed mappers convert between camelCase TypeScript interfaces and wire format. Use `*ToWire()` when building requests and `*FromWire()` when parsing responses.

### Request mappers (camelCase → snake_case)

| Mapper | Converts |
|--------|----------|
| `reservationCreateRequestToWire(req)` | `ReservationCreateRequest` → wire body |
| `commitRequestToWire(req)` | `CommitRequest` → wire body |
| `releaseRequestToWire(req)` | `ReleaseRequest` → wire body |
| `reservationExtendRequestToWire(req)` | `ReservationExtendRequest` → wire body |
| `decisionRequestToWire(req)` | `DecisionRequest` → wire body |
| `eventCreateRequestToWire(req)` | `EventCreateRequest` → wire body |
| `metricsToWire(metrics)` | `CyclesMetrics` → wire metrics |

### Response mappers (snake_case → camelCase)

| Mapper | Returns |
|--------|---------|
| `reservationCreateResponseFromWire(wire)` | `ReservationCreateResponse` |
| `commitResponseFromWire(wire)` | `CommitResponse` |
| `releaseResponseFromWire(wire)` | `ReleaseResponse` |
| `reservationExtendResponseFromWire(wire)` | `ReservationExtendResponse` |
| `decisionResponseFromWire(wire)` | `DecisionResponse` |
| `eventCreateResponseFromWire(wire)` | `EventCreateResponse` |
| `reservationDetailFromWire(wire)` | `ReservationDetail` |
| `reservationSummaryFromWire(wire)` | `ReservationSummary` |
| `reservationListResponseFromWire(wire)` | `ReservationListResponse` |
| `balanceResponseFromWire(wire)` | `BalanceResponse` |
| `errorResponseFromWire(wire)` | `ErrorResponse \| undefined` |
| `capsFromWire(wire)` | `Caps \| undefined` |

## Helper Functions

```typescript
import {
  isAllowed,
  isDenied,
  isRetryableErrorCode,
  errorCodeFromString,
  isToolAllowed,
  isMetricsEmpty,
} from "runcycles";

// Decision helpers
isAllowed(decision);  // true for ALLOW or ALLOW_WITH_CAPS
isDenied(decision);   // true for DENY

// Error code helpers
isRetryableErrorCode(errorCode);       // true for INTERNAL_ERROR or UNKNOWN
errorCodeFromString("BUDGET_EXCEEDED"); // ErrorCode.BUDGET_EXCEEDED (or UNKNOWN for unrecognized)

// Caps helpers — check if a tool is allowed given the caps
isToolAllowed(caps, "web_search");  // checks toolAllowlist/toolDenylist

// Metrics helpers
isMetricsEmpty(metrics);  // true if all fields are undefined
```

## Enums

```typescript
import { Unit, Decision, CommitOveragePolicy, ReservationStatus, ErrorCode } from "runcycles";

// Budget units
Unit.USD_MICROCENTS  // 1 USD = 100_000_000 microcents
Unit.TOKENS
Unit.CREDITS
Unit.RISK_POINTS

// Budget decisions
Decision.ALLOW           // Full budget available
Decision.ALLOW_WITH_CAPS // Allowed with soft-landing caps
Decision.DENY            // Budget exhausted

// Overage policies (for commit and events)
CommitOveragePolicy.REJECT               // Reject if over budget
CommitOveragePolicy.ALLOW_IF_AVAILABLE   // Allow up to remaining budget
CommitOveragePolicy.ALLOW_WITH_OVERDRAFT // Allow with overdraft (creates debt)

// Reservation statuses
ReservationStatus.ACTIVE
ReservationStatus.COMMITTED
ReservationStatus.RELEASED
ReservationStatus.EXPIRED

// Error codes
ErrorCode.BUDGET_EXCEEDED
ErrorCode.OVERDRAFT_LIMIT_EXCEEDED
ErrorCode.DEBT_OUTSTANDING
ErrorCode.RESERVATION_EXPIRED
ErrorCode.RESERVATION_FINALIZED
ErrorCode.IDEMPOTENCY_MISMATCH
ErrorCode.UNIT_MISMATCH
ErrorCode.INVALID_REQUEST
ErrorCode.UNAUTHORIZED
ErrorCode.FORBIDDEN
ErrorCode.NOT_FOUND
ErrorCode.INTERNAL_ERROR
```

## Examples

See the [`examples/`](./examples/) directory:

- [`basic-usage.ts`](./examples/basic-usage.ts) — Programmatic client with full reserve/commit lifecycle
- [`async-usage.ts`](./examples/async-usage.ts) — `withCycles` with async/await and context access
- [`decorator-usage.ts`](./examples/decorator-usage.ts) — `withCycles` patterns
- [`vercel-ai-sdk/`](./examples/vercel-ai-sdk/) — Next.js + Vercel AI SDK streaming integration
- [`openai-sdk/`](./examples/openai-sdk/) — Direct OpenAI SDK with non-streaming and streaming patterns
- [`anthropic-sdk/`](./examples/anthropic-sdk/) — Anthropic Claude SDK with Caps-aware `max_tokens`
- [`langchain-js/`](./examples/langchain-js/) — LangChain.js chains and ReAct agents with Caps integration
- [`express-middleware/`](./examples/express-middleware/) — Reusable Express middleware for budget governance

## Features

- **`withCycles` HOF**: Wraps async functions with automatic reserve/execute/commit lifecycle
- **`reserveForStream`**: First-class streaming adapter — reserve before, heartbeat during, commit on finish
- **Programmatic client**: Full control via `CyclesClient` with wire-format passthrough
- **Typed wire-format mappers**: Convert between camelCase TypeScript and snake_case wire format
- **Automatic heartbeat**: TTL extension keeps reservations alive during long operations
- **Commit retry**: Failed commits are retried with exponential backoff in the background
- **Context access**: `getCyclesContext()` provides reservation details inside guarded functions
- **Typed exceptions**: `BudgetExceededError`, `OverdraftLimitExceededError`, and more
- **Zero runtime dependencies**: Uses built-in `fetch` and `AsyncLocalStorage`
- **Response metadata**: Access `requestId`, `rateLimitRemaining`, `rateLimitReset`, and `cyclesTenant`
- **Environment config**: `CyclesConfig.fromEnv()` with custom prefix support
- **Dual ESM/CJS**: Works with both module systems
- **Input validation**: Client-side validation of TTL, amounts, subject fields, and more

## License

Apache-2.0
