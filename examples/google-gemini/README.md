# Cycles + Google Gemini Example

Budget-governed chat completions using the [Google Generative AI SDK](https://github.com/google-gemini/generative-ai-js) with [Cycles](https://runcycles.io).

Two scripts demonstrate both integration patterns:

- **Non-streaming** (`withCycles`) — wraps `model.generateContent()` and commits actual token usage from `response.usageMetadata`
- **Streaming** (`reserveForStream`) — reserves budget before the stream starts, uses `model.generateContentStream()`, and commits when the stream finishes

Every LLM call is:

1. **Reserved** against the tenant's budget before the call starts
2. **Executed** with automatic heartbeat keeping the reservation alive (streaming)
3. **Committed** with actual token usage from the Gemini response
4. **Released** if the call fails or is aborted

If the budget is exhausted, the request is denied with a `BudgetExceededError` before any LLM call is made.

## Requirements

- **Node.js 20+**
- A Google API key with Gemini access
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
| `GOOGLE_API_KEY` | Your Google API key |

## How It Works

### Non-streaming (`src/non-streaming.ts`)

Uses `withCycles` to wrap the Gemini call. Respects `caps.maxTokens` from the budget system to limit output length:

```typescript
import { withCycles, getCyclesContext } from "runcycles";

const callGemini = withCycles(
  {
    client: cyclesClient,
    actionKind: "llm.completion",
    actionName: "gemini-2.0-flash",
    estimate: (prompt) => calculateCostMicrocents(MODEL, estimateInputTokens(prompt), MAX_TOKENS),
    actual: (result) => calculateCostMicrocents(MODEL,
      result.response.usageMetadata?.promptTokenCount ?? 0,
      result.response.usageMetadata?.candidatesTokenCount ?? 0),
  },
  async (prompt) => {
    const ctx = getCyclesContext();
    let maxTokens = 1024;
    if (ctx?.caps?.maxTokens) {
      maxTokens = Math.min(maxTokens, ctx.caps.maxTokens);
    }
    const model = genAI.getGenerativeModel({ model: MODEL, generationConfig: { maxOutputTokens: maxTokens } });
    return model.generateContent(prompt);
  },
);
```

### Streaming (`src/streaming.ts`)

Uses `reserveForStream` with Gemini's streaming API:

```typescript
import { reserveForStream } from "runcycles";

// 1. Reserve budget
const handle = await reserveForStream({ client, estimate, actionKind: "llm.completion", ... });

// 2. Stream content
const streamResult = await model.generateContentStream(prompt);
for await (const chunk of streamResult.stream) {
  process.stdout.write(chunk.text());
}

// 3. Get usage from the aggregated response and commit
const aggregated = await streamResult.response;
const usage = aggregated.usageMetadata;
await handle.commit(actualCost, {
  tokensInput: usage?.promptTokenCount,
  tokensOutput: usage?.candidatesTokenCount,
});
```

The Gemini SDK aggregates usage metadata in the response object, available after the stream completes via `streamResult.response`.

## Testing

```bash
# Run the non-streaming example
npm run non-streaming

# Run the streaming example
npm run streaming
```
