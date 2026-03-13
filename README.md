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

const handle = await reserveForStream({
  client,
  estimate: 5000,
  unit: "USD_MICROCENTS",
  actionKind: "llm.completion",
  actionName: "gpt-4o",
});

try {
  // Start streaming (e.g. Vercel AI SDK's streamText)
  const stream = streamText({
    model: openai("gpt-4o"),
    messages,
    onFinish: async ({ usage }) => {
      const actualCost = (usage.promptTokens + usage.completionTokens) * 3;
      await handle.commit(actualCost, {
        tokensInput: usage.promptTokens,
        tokensOutput: usage.completionTokens,
      });
    },
  });

  return stream.toDataStreamResponse();
} catch (err) {
  await handle.release("stream_error");
  throw err;
} finally {
  handle.dispose(); // Always stop the heartbeat
}
```

The `StreamReservation` handle provides:
- `handle.commit(actual, metrics?, metadata?)` — commit actual usage after stream completes
- `handle.release(reason?)` — release reservation on error/abort (best-effort)
- `handle.dispose()` — stop heartbeat timer (always call in `finally`)
- `handle.reservationId` — the reservation ID
- `handle.decision` — the budget decision (ALLOW or ALLOW_WITH_CAPS)
- `handle.caps` — soft-landing caps, if any

### Programmatic client

The client sends wire-format (snake_case) request bodies and returns wire-format responses:

```typescript
import { CyclesClient, CyclesConfig } from "runcycles";

const config = new CyclesConfig({ baseUrl: "http://localhost:7878", apiKey: "your-api-key" });
const client = new CyclesClient(config);

// 1. Reserve budget
const response = await client.createReservation({
  idempotency_key: "req-001",
  subject: { tenant: "acme", agent: "support-bot" },
  action: { kind: "llm.completion", name: "gpt-4" },
  estimate: { unit: "USD_MICROCENTS", amount: 500_000 },
  ttl_ms: 30_000,
});

if (response.isSuccess) {
  const reservationId = response.getBodyAttribute("reservation_id") as string;

  // 2. Do work ...

  // 3. Commit actual usage
  await client.commitReservation(reservationId, {
    idempotency_key: "commit-001",
    actual: { unit: "USD_MICROCENTS", amount: 420_000 },
    metrics: { tokens_input: 1200, tokens_output: 800 },
  });
}
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
const response = await client.decide({
  idempotency_key: "decide-001",
  subject: { tenant: "acme" },
  action: { kind: "llm.completion", name: "gpt-4" },
  estimate: { unit: "USD_MICROCENTS", amount: 500_000 },
});

if (response.isSuccess) {
  const decision = response.getBodyAttribute("decision"); // "ALLOW", "ALLOW_WITH_CAPS", or "DENY"
}
```

## Events (direct debit)

```typescript
await client.createEvent({
  idempotency_key: "evt-001",
  subject: { tenant: "acme" },
  action: { kind: "api.call", name: "geocode" },
  actual: { unit: "USD_MICROCENTS", amount: 1_500 },
});
```

## Querying

### Balances

```typescript
const response = await client.getBalances({ tenant: "acme" });
if (response.isSuccess) {
  console.log(response.body); // { balances: [...], has_more, next_cursor }
}
```

### Reservations

```typescript
// List reservations
const list = await client.listReservations({ tenant: "acme" });

// Get a specific reservation
const detail = await client.getReservation("r-123");
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

## Features

- **`withCycles` HOF**: Wraps async functions with automatic reserve/execute/commit lifecycle
- **`reserveForStream`**: First-class streaming adapter — reserve before, heartbeat during, commit on finish
- **Programmatic client**: Full control via `CyclesClient` with wire-format passthrough
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
