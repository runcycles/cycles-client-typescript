# Cycles + Anthropic Claude SDK Example

Budget-governed chat completions using the official [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) with [Cycles](https://runcycles.com).

Two scripts demonstrate both integration patterns:

- **Non-streaming** (`withCycles`) — wraps `anthropic.messages.create()` and commits actual token usage from `response.usage`
- **Streaming** (`reserveForStream`) — reserves budget before the stream starts, uses `anthropic.messages.stream()`, and commits when the stream finishes

Every LLM call is:

1. **Reserved** against the tenant's budget before the call starts
2. **Executed** with automatic heartbeat keeping the reservation alive (streaming)
3. **Committed** with actual token usage from the Anthropic response
4. **Released** if the call fails or is aborted

If the budget is exhausted, the request is denied with a `BudgetExceededError` before any LLM call is made.

## Requirements

- **Node.js 20+**
- An Anthropic API key
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
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

## How It Works

### Non-streaming (`src/non-streaming.ts`)

Uses `withCycles` to wrap the Anthropic call. Respects `caps.maxTokens` from the budget system to limit output length:

```typescript
import { withCycles, getCyclesContext } from "runcycles";

const callClaude = withCycles(
  {
    client: cyclesClient,
    actionKind: "llm.completion",
    actionName: "claude-sonnet-4-20250514",
    estimate: (messages) => calculateCostMicrocents(MODEL, estimateInputTokens(messages), MAX_TOKENS),
    actual: (response) => calculateCostMicrocents(MODEL, response.usage.input_tokens, response.usage.output_tokens),
  },
  async (messages) => {
    const ctx = getCyclesContext();
    let maxTokens = 1024;
    if (ctx?.caps?.maxTokens) {
      maxTokens = Math.min(maxTokens, ctx.caps.maxTokens);
    }
    return anthropic.messages.create({ model: MODEL, max_tokens: maxTokens, messages });
  },
);
```

### Streaming (`src/streaming.ts`)

Uses `reserveForStream` with Anthropic's `.stream()` helper:

```typescript
import { reserveForStream } from "runcycles";

// 1. Reserve budget
const handle = await reserveForStream({ client, estimate, actionKind: "llm.completion", ... });

// 2. Stream — the heartbeat keeps the reservation alive
const stream = anthropic.messages.stream({ model, max_tokens, messages });
stream.on("text", (text) => process.stdout.write(text));
const finalMessage = await stream.finalMessage();

// 3. Commit actual usage from the final message
await handle.commit(actualCost, {
  tokensInput: finalMessage.usage.input_tokens,
  tokensOutput: finalMessage.usage.output_tokens,
});
```

The Anthropic SDK's `.stream()` helper aggregates usage from `message_start` (input tokens) and `message_delta` (output tokens) events into `finalMessage().usage`, so you don't need to track them separately.

## Testing

```bash
# Run the non-streaming example
npm run non-streaming

# Run the streaming example
npm run streaming
```
