# Cycles + OpenAI SDK Example

Budget-governed chat completions using the official [OpenAI Node SDK](https://github.com/openai/openai-node) with [Cycles](https://runcycles.io).

Two scripts demonstrate both integration patterns side-by-side:

- **Non-streaming** (`withCycles`) — wraps `openai.chat.completions.create()` and commits actual token usage from `response.usage`
- **Streaming** (`reserveForStream`) — reserves budget before the stream starts, iterates over chunks, and commits when the stream finishes

Every LLM call is:

1. **Reserved** against the tenant's budget before the call starts
2. **Executed** with automatic heartbeat keeping the reservation alive (streaming)
3. **Committed** with actual token usage extracted from the OpenAI response
4. **Released** if the call fails or is aborted

If the budget is exhausted, the request is denied with a `BudgetExceededError` before any LLM call is made.

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

# Run the non-streaming example
npm run non-streaming

# Run the streaming example
npm run streaming
```

## Environment Variables

| Variable | Description |
|---|---|
| `CYCLES_BASE_URL` | Cycles server URL (e.g. `http://localhost:7878`) |
| `CYCLES_API_KEY` | Your Cycles API key |
| `CYCLES_TENANT` | Default tenant for budget scoping |
| `OPENAI_API_KEY` | Your OpenAI API key |

## How It Works

### Non-streaming (`src/non-streaming.ts`)

Uses `withCycles` to wrap the OpenAI call with automatic reserve/commit:

```typescript
import { withCycles, getCyclesContext } from "runcycles";

const callLlm = withCycles(
  {
    client: cyclesClient,
    actionKind: "llm.completion",
    actionName: "gpt-4o",
    estimate: (messages) => calculateCostMicrocents("gpt-4o", estimateInputTokens(messages), ...),
    actual: (response) => calculateCostMicrocents("gpt-4o", response.usage.prompt_tokens, ...),
  },
  async (messages) => {
    const response = await openai.chat.completions.create({ model: "gpt-4o", messages });
    const ctx = getCyclesContext();
    if (ctx && response.usage) {
      ctx.metrics = { tokensInput: response.usage.prompt_tokens, ... };
    }
    return response;
  },
);
```

### Streaming (`src/streaming.ts`)

Uses `reserveForStream` for manual lifecycle control:

```typescript
import { reserveForStream } from "runcycles";

// 1. Reserve budget
const handle = await reserveForStream({ client, estimate, actionKind: "llm.completion", ... });

// 2. Stream with usage tracking
const stream = await openai.chat.completions.create({
  model: "gpt-4o",
  messages,
  stream: true,
  stream_options: { include_usage: true }, // Required for token counts
});

for await (const chunk of stream) {
  // process chunks...
  if (chunk.usage) usage = chunk.usage; // final chunk has usage
}

// 3. Commit actual usage
await handle.commit(actualCost, { tokensInput, tokensOutput });
```

**Important:** The `stream_options: { include_usage: true }` parameter is required to get token counts in streaming mode. Without it, the final chunk will not include usage data.

## Testing

```bash
# Run the non-streaming example
npm run non-streaming

# Run the streaming example
npm run streaming
```
