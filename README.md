# Cycles TypeScript Client

TypeScript client for the [Cycles](https://runcycles.io) budget-management protocol.

## Installation

```bash
npm install runcycles
```

## Quick Start

### Higher-order function (recommended)

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

### Streaming adapter

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

The handle owns its finalization: `commit()` and `release()` automatically stop the heartbeat.
There is no need for a `finally { handle.dispose() }` block — in a streaming handler, the
`finally` would run when the handler returns the response object, not when the stream ends.

The handle is **once-only and race-safe**: in real streaming code, multiple terminal paths
can fire (onFinish, error, abort signal, client disconnect). Only the first terminal call wins:
- `commit()` throws `CyclesError` if already finalized (dropping a commit silently hides bugs)
- `release()` is a silent no-op if already finalized (best-effort by design)
- `handle.finalized` — check whether the handle has been finalized

The `StreamReservation` handle provides:
- `handle.commit(actual, metrics?, metadata?)` — commit actual usage and stop heartbeat (throws if finalized)
- `handle.release(reason?)` — release reservation and stop heartbeat (no-op if finalized)
- `handle.dispose()` — stop heartbeat only, for startup failures (no-op if finalized)
- `handle.finalized` — true after any terminal call
- `handle.reservationId` — the reservation ID
- `handle.decision` — the budget decision (ALLOW or ALLOW_WITH_CAPS)
- `handle.caps` — soft-landing caps, if any

### Programmatic client

The client sends wire-format (snake_case) request bodies and returns wire-format responses.
Use the typed mappers to convert between camelCase TypeScript interfaces and wire format:

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

## Configuration

### From environment variables

```typescript
import { CyclesConfig } from "runcycles";

const config = CyclesConfig.fromEnv();
// Reads: CYCLES_BASE_URL, CYCLES_API_KEY, CYCLES_TENANT, etc.
```

### All options

```typescript
new CyclesConfig({
  baseUrl: "http://localhost:7878",
  apiKey: "your-api-key",
  tenant: "acme",
  workspace: "prod",
  app: "chat",
  workflow: "refund-flow",
  agent: "planner",
  toolset: "search-tools",
  connectTimeout: 2_000,   // ms
  readTimeout: 5_000,      // ms
  retryEnabled: true,
  retryMaxAttempts: 5,
  retryInitialDelay: 500,  // ms
  retryMultiplier: 2.0,
  retryMaxDelay: 30_000,   // ms
});
```

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

## Error handling

```typescript
const response = await client.createReservation({
  idempotency_key: "req-002",
  subject: { tenant: "acme" },
  action: { kind: "llm.completion", name: "gpt-4" },
  estimate: { unit: "USD_MICROCENTS", amount: 500_000 },
});

if (response.isTransportError) {
  console.log(`Transport error: ${response.errorMessage}`);
} else if (!response.isSuccess) {
  console.log(`Error ${response.status}: ${response.errorMessage}`);
  console.log(`Request ID: ${response.requestId}`);
}
```

With `withCycles` or `reserveForStream`, protocol errors are thrown as typed exceptions:

```typescript
import { withCycles, BudgetExceededError, CyclesProtocolError } from "runcycles";

const guarded = withCycles({ estimate: 1000, client }, async () => "result");

try {
  await guarded();
} catch (err) {
  if (err instanceof BudgetExceededError) {
    console.log("Budget exhausted — degrade or queue");
  } else if (err instanceof CyclesProtocolError) {
    if (err.isRetryable() && err.retryAfterMs) {
      console.log(`Retry after ${err.retryAfterMs}ms`);
    }
    console.log(`Protocol error: ${err.message}, code: ${err.errorCode}`);
  }
}
```

Exception hierarchy:

| Exception | When |
|---|---|
| `CyclesError` | Base for all Cycles errors |
| `CyclesProtocolError` | Server returned a protocol-level error |
| `BudgetExceededError` | Budget insufficient for the reservation |
| `OverdraftLimitExceededError` | Debt exceeds the overdraft limit |
| `DebtOutstandingError` | Outstanding debt blocks new reservations |
| `ReservationExpiredError` | Operating on an expired reservation |
| `ReservationFinalizedError` | Operating on an already-committed/released reservation |
| `CyclesTransportError` | Network-level failure (connection, DNS, timeout) |

## Preflight checks (decide)

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

## Events (direct debit)

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
  }),
);

if (response.isSuccess) {
  const parsed = eventCreateResponseFromWire(response.body!);
  console.log(`Event ID: ${parsed.eventId}, Status: ${parsed.status}`);
}
```

## Querying

### Balances

At least one subject filter (`tenant`, `workspace`, `app`, `workflow`, `agent`, or `toolset`) is required:

```typescript
import { balanceResponseFromWire } from "runcycles";

const response = await client.getBalances({ tenant: "acme" });
if (response.isSuccess) {
  const parsed = balanceResponseFromWire(response.body!);
  for (const balance of parsed.balances) {
    console.log(`${balance.scopePath}: remaining=${balance.remaining.amount}, spent=${balance.spent?.amount}`);
    if (balance.isOverLimit) {
      console.log(`  OVER LIMIT — debt: ${balance.debt?.amount}, limit: ${balance.overdraftLimit?.amount}`);
    }
  }
  if (parsed.hasMore) {
    // Fetch next page with: client.getBalances({ tenant: "acme", cursor: parsed.nextCursor })
  }
}
```

### Reservations

```typescript
import { reservationListResponseFromWire, reservationDetailFromWire } from "runcycles";

// List reservations (supports filters: tenant, workspace, app, workflow, agent, toolset, status, idempotency_key)
const list = await client.listReservations({ tenant: "acme", status: "ACTIVE" });
if (list.isSuccess) {
  const parsed = reservationListResponseFromWire(list.body!);
  for (const r of parsed.reservations) {
    console.log(`${r.reservationId}: ${r.status} — ${r.reserved.amount} ${r.reserved.unit}`);
  }
}

// Get a specific reservation
const detail = await client.getReservation("r-123");
if (detail.isSuccess) {
  const parsed = reservationDetailFromWire(detail.body!);
  console.log(`Status: ${parsed.status}, Committed: ${parsed.committed?.amount}`);
}
```

### Release and extend

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

## Dry run (shadow mode)

```typescript
const guarded = withCycles(
  { estimate: 1000, dryRun: true, client },
  async () => "result",
);

// In dry-run mode, the function does not execute — a DryRunResult is returned instead.
const dryResult = await guarded();
```

## Context access

Inside a `withCycles`-guarded function, access the active reservation context:

```typescript
import { getCyclesContext } from "runcycles";

const guarded = withCycles({ estimate: 1000, client }, async () => {
  const ctx = getCyclesContext();

  // Read reservation details
  console.log(ctx?.reservationId, ctx?.decision, ctx?.caps);

  // Set metrics (included in the commit)
  if (ctx) {
    ctx.metrics = { tokensInput: 50, tokensOutput: 200, modelVersion: "gpt-4o" };
    ctx.commitMetadata = { requestId: "abc" };
  }

  return "result";
});
```

## Wire-format mappers

The client operates on snake_case wire-format JSON. Typed mappers convert between camelCase TypeScript interfaces and the wire format, so you can choose your preferred style:

### Request mappers (camelCase → snake_case)

| Mapper | Converts |
|---|---|
| `reservationCreateRequestToWire(req)` | `ReservationCreateRequest` → wire body |
| `commitRequestToWire(req)` | `CommitRequest` → wire body |
| `releaseRequestToWire(req)` | `ReleaseRequest` → wire body |
| `reservationExtendRequestToWire(req)` | `ReservationExtendRequest` → wire body |
| `decisionRequestToWire(req)` | `DecisionRequest` → wire body |
| `eventCreateRequestToWire(req)` | `EventCreateRequest` → wire body |
| `metricsToWire(metrics)` | `CyclesMetrics` → wire metrics |

### Response mappers (snake_case → camelCase)

| Mapper | Returns |
|---|---|
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

## Features

- **`withCycles` HOF**: Wraps async functions with automatic reserve/execute/commit lifecycle
- **`reserveForStream`**: First-class streaming adapter — reserve before, heartbeat during, commit on finish
- **Programmatic client**: Full control via `CyclesClient` with wire-format passthrough
- **Typed wire-format mappers**: Convert between camelCase TypeScript and snake_case wire format for all request/response types
- **Automatic heartbeat**: TTL extension at half-interval keeps reservations alive
- **Commit retry**: Failed commits are retried with exponential backoff
- **Context access**: `getCyclesContext()` provides reservation details inside guarded functions
- **Typed exceptions**: `BudgetExceededError`, `OverdraftLimitExceededError`, etc.
- **Zero dependencies**: Uses built-in `fetch` and `AsyncLocalStorage`
- **Response metadata**: Access `requestId`, `rateLimitRemaining`, `rateLimitReset`, and `cyclesTenant` on every response
- **Environment config**: `CyclesConfig.fromEnv()` for 12-factor apps
- **Dual ESM/CJS**: Works with both module systems

## Requirements

- Node.js 20+
- TypeScript 5+ (for type definitions)
