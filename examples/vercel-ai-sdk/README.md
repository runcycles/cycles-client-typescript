# Cycles + Vercel AI SDK Example

A Next.js App Router API route that wraps the Vercel AI SDK's `streamText` with
[Cycles](https://runcycles.io) budget governance using the streaming adapter.

Every LLM call is:

1. **Reserved** against the tenant's budget before the stream starts
2. **Kept alive** via heartbeat while the stream is open
3. **Committed** with actual token usage when the stream finishes (`onFinish`)
4. **Released** if the stream fails or is aborted

If the budget is exhausted, the request is denied with a 402 before any LLM
call is made.

## Requirements

- **Node.js 20+** (required for `fetch`, `AsyncLocalStorage`)
- The route uses `export const runtime = 'nodejs'` to ensure the Node.js runtime

## Setup

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env.local

# Start the dev server
npm run dev
```

## Environment Variables

| Variable | Description |
|---|---|
| `CYCLES_BASE_URL` | Cycles server URL (e.g. `http://localhost:7878`) |
| `CYCLES_API_KEY` | Your Cycles API key |
| `CYCLES_TENANT` | Default tenant for budget scoping |
| `OPENAI_API_KEY` | Your OpenAI API key |

## How It Works

The core integration is in `app/api/chat/route.ts` using `reserveForStream`:

```typescript
import { reserveForStream, BudgetExceededError } from "runcycles";

// 1. Reserve budget before starting the stream
const handle = await reserveForStream({
  client: cyclesClient,
  estimate: estimatedCostMicrocents,
  actionKind: "llm.completion",
  actionName: "gpt-4o",
  unit: "USD_MICROCENTS",
});

// 2. Start streaming — heartbeat keeps the reservation alive
const result = streamText({
  model: openai("gpt-4o"),
  messages,
  onFinish: async ({ usage }) => {
    try {
      // 3. Commit actual usage when the stream finishes
      await handle.commit(actualCost, {
        tokensInput: usage.promptTokens,
        tokensOutput: usage.completionTokens,
      });
    } finally {
      handle.dispose(); // Stop heartbeat
    }
  },
});
```

The `reserveForStream` adapter:

- Creates a budget reservation with the estimated cost
- Starts a heartbeat to keep the reservation alive during streaming
- Returns a handle with `commit()`, `release()`, and `dispose()` methods
- `commit()` — records actual usage after the stream finishes
- `release()` — returns reserved budget on error/abort
- `dispose()` — stops the heartbeat timer (always call in `finally`)

## Testing

```bash
# Send a chat request
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello!"}]}'
```
