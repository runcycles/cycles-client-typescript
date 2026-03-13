# Cycles + Express Middleware Example

Reusable Express middleware for [Cycles](https://runcycles.io) budget governance, demonstrating how to protect any API route with budget checks.

This example shows two patterns on the same server:

- **`/api/chat`** — streaming route protected by `cyclesGuard` middleware (reserves budget before the handler runs)
- **`/api/summarize`** — non-streaming route using `withCycles` inline (no middleware)
- **`/api/balance`** — observability endpoint showing current budget balances

Every LLM call is:

1. **Reserved** against the tenant's budget before the call starts
2. **Kept alive** via heartbeat while the stream is open (streaming routes)
3. **Committed** with actual token usage when the operation finishes
4. **Released** if the client disconnects or an error occurs

If the budget is exhausted, the middleware returns `402 Payment Required` before any LLM call is made.

## Requirements

- **Node.js 20+**
- An OpenAI API key
- A running Cycles server

## Setup

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env

# Start the server
npm run dev
```

## Environment Variables

| Variable | Description |
|---|---|
| `CYCLES_BASE_URL` | Cycles server URL (e.g. `http://localhost:7878`) |
| `CYCLES_API_KEY` | Your Cycles API key |
| `CYCLES_TENANT` | Default tenant for budget scoping |
| `OPENAI_API_KEY` | Your OpenAI API key |
| `PORT` | Server port (default: 3000) |

## How It Works

### Budget Middleware (`src/middleware/cycles-guard.ts`)

A factory function that returns Express middleware. Attach it to any route:

```typescript
import { cyclesGuard } from "./middleware/cycles-guard.js";

app.use(
  "/api/chat",
  cyclesGuard({
    client: cyclesClient,
    actionKind: "llm.completion",
    actionName: "gpt-4o",
    estimateFn: (req) => estimateCostFromRequest(req),
  }),
  chatRoute,
);
```

The middleware:
- Calls `reserveForStream()` to reserve budget
- Attaches the handle to `res.locals.cyclesHandle` for the route handler
- Listens for `req.close` to release the reservation if the client disconnects
- Returns 402 on `BudgetExceededError`

### Streaming Route (`src/routes/chat.ts`)

Reads the handle from `res.locals.cyclesHandle` (already reserved by the middleware):

```typescript
const handle = res.locals.cyclesHandle;
const stream = await openai.chat.completions.create({ model, messages, stream: true });
// stream chunks to client via res.write()...
await handle.commit(actualCost, metrics);
```

### Non-streaming Route (`src/routes/summarize.ts`)

Uses `withCycles` directly without the middleware, showing that both patterns can coexist:

```typescript
const summarize = withCycles({ client, estimate, actual, ... }, async (text) => {
  return openai.chat.completions.create({ model: "gpt-4o-mini", messages });
});
```

## Testing

```bash
# Streaming chat
curl -N -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello!"}]}'

# Non-streaming summarization
curl -X POST http://localhost:3000/api/summarize \
  -H "Content-Type: application/json" \
  -d '{"text": "Long text to summarize..."}'

# Check budget balance
curl http://localhost:3000/api/balance
```
