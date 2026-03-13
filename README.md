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

### Programmatic client

```typescript
import {
  CyclesClient,
  CyclesConfig,
  Unit,
} from "runcycles";

const config = new CyclesConfig({ baseUrl: "http://localhost:7878", apiKey: "your-api-key" });
const client = new CyclesClient(config);

// 1. Reserve budget
const response = await client.createReservation({
  idempotencyKey: "req-001",
  subject: { tenant: "acme", agent: "support-bot" },
  action: { kind: "llm.completion", name: "gpt-4" },
  estimate: { unit: Unit.USD_MICROCENTS, amount: 500_000 },
  ttlMs: 30_000,
});

if (response.isSuccess) {
  const reservationId = response.getBodyAttribute("reservationId") as string;

  // 2. Do work ...

  // 3. Commit actual usage
  await client.commitReservation(reservationId, {
    idempotencyKey: "commit-001",
    actual: { unit: Unit.USD_MICROCENTS, amount: 420_000 },
    metrics: { tokensInput: 1200, tokensOutput: 800 },
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
import { CyclesClient, CyclesConfig } from "runcycles";

const config = new CyclesConfig({ baseUrl: "http://localhost:7878", apiKey: "your-key" });
const client = new CyclesClient(config);

const response = await client.createReservation({
  idempotencyKey: "req-002",
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

With `withCycles`, protocol errors are thrown as typed exceptions:

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
  idempotencyKey: "decide-001",
  subject: { tenant: "acme" },
  action: { kind: "llm.completion", name: "gpt-4" },
  estimate: { unit: "USD_MICROCENTS", amount: 500_000 },
});

if (response.isSuccess) {
  const decision = response.getBodyAttribute("decision"); // "ALLOW" or "DENY"
}
```

## Events (direct debit)

```typescript
await client.createEvent({
  idempotencyKey: "evt-001",
  subject: { tenant: "acme" },
  action: { kind: "api.call", name: "geocode" },
  actual: { unit: "USD_MICROCENTS", amount: 1_500 },
});
```

## Querying balances

```typescript
const response = await client.getBalances({ tenant: "acme" });
if (response.isSuccess) {
  console.log(response.body);
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

## Features

- **`withCycles` HOF**: Wraps async functions with automatic reserve/execute/commit lifecycle
- **Programmatic client**: Full control via `CyclesClient`
- **Automatic heartbeat**: TTL extension at half-interval keeps reservations alive
- **Commit retry**: Failed commits are retried with exponential backoff
- **Context access**: `getCyclesContext()` provides reservation details inside guarded functions
- **Typed exceptions**: `BudgetExceededError`, `OverdraftLimitExceededError`, etc.
- **Zero dependencies**: Uses built-in `fetch` and `AsyncLocalStorage` (Node 18+)
- **Response metadata**: Access `requestId`, `rateLimitRemaining`, and `rateLimitReset` on every response
- **Environment config**: `CyclesConfig.fromEnv()` for 12-factor apps
- **Dual ESM/CJS**: Works with both module systems

## Requirements

- Node.js 18+
- TypeScript 5+ (for type definitions)
