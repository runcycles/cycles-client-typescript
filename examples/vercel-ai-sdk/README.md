# Cycles + Vercel AI SDK Example

A Next.js App Router API route that wraps the Vercel AI SDK's `streamText` with
[Cycles](https://runcycles.io) budget governance.

Every LLM call is:

1. **Reserved** against the tenant's budget before execution
2. **Streamed** to the client in real time
3. **Committed** with actual token usage after the stream completes

If the budget is exhausted, the request is denied with a 402 before any LLM
call is made.

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

The core integration is in `app/api/chat/route.ts`:

```typescript
const result = await withCycles(
  {
    estimate: estimatedCostMicrocents,
    actionKind: "llm.completion",
    actionName: "gpt-4o",
    unit: "USD_MICROCENTS",
    client: cyclesClient,
  },
  async () => {
    const result = streamText({
      model: openai("gpt-4o"),
      messages,
    });

    // Attach metrics for the commit
    const ctx = getCyclesContext();
    if (ctx) {
      result.usage.then((usage) => {
        ctx.metrics = {
          tokensInput: usage.promptTokens,
          tokensOutput: usage.completionTokens,
        };
      });
    }

    return result;
  },
)();

return result.toDataStreamResponse();
```

The `withCycles` wrapper:

- Creates a budget reservation for the estimated cost
- Starts a heartbeat to keep the reservation alive during streaming
- Executes the `streamText` call
- Commits actual usage (with token metrics) after the function returns
- Releases the reservation if the function throws

## Testing

```bash
# Send a chat request
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello!"}]}'
```
