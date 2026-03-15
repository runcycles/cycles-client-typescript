# Cycles + AWS Bedrock Example

Budget-governed chat completions using [AWS Bedrock](https://aws.amazon.com/bedrock/) with [Cycles](https://runcycles.io).

Two scripts demonstrate both integration patterns:

- **Non-streaming** (`withCycles`) — wraps Bedrock's `InvokeModelCommand` and commits actual token usage from the response
- **Streaming** (`reserveForStream`) — reserves budget before the stream starts, uses `InvokeModelWithResponseStreamCommand`, and commits when the stream finishes

Every LLM call is:

1. **Reserved** against the tenant's budget before the call starts
2. **Executed** with automatic heartbeat keeping the reservation alive (streaming)
3. **Committed** with actual token usage from the Bedrock response
4. **Released** if the call fails or is aborted

If the budget is exhausted, the request is denied with a `BudgetExceededError` before any LLM call is made.

## Requirements

- **Node.js 20+**
- AWS credentials with Bedrock model access
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
| `AWS_ACCESS_KEY_ID` | AWS access key (or use IAM role / `AWS_PROFILE`) |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key |
| `AWS_REGION` | AWS region (default: `us-east-1`) |

## How It Works

### Non-streaming (`src/non-streaming.ts`)

Uses `withCycles` to wrap the Bedrock call. Respects `caps.maxTokens` from the budget system to limit output length:

```typescript
import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { withCycles, getCyclesContext } from "runcycles";

const callBedrock = withCycles(
  {
    client: cyclesClient,
    actionKind: "llm.completion",
    actionName: "anthropic.claude-sonnet-4-20250514-v1:0",
    estimate: (messages) => calculateCostMicrocents(MODEL, estimateInputTokens(messages), MAX_TOKENS),
    actual: (response) => calculateCostMicrocents(MODEL, response.usage.input_tokens, response.usage.output_tokens),
  },
  async (messages) => {
    const ctx = getCyclesContext();
    let maxTokens = 1024;
    if (ctx?.caps?.maxTokens) {
      maxTokens = Math.min(maxTokens, ctx.caps.maxTokens);
    }
    const command = new InvokeModelCommand({
      modelId: MODEL,
      body: JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: maxTokens, messages }),
    });
    return JSON.parse(new TextDecoder().decode((await bedrock.send(command)).body));
  },
);
```

### Streaming (`src/streaming.ts`)

Uses `reserveForStream` with Bedrock's `InvokeModelWithResponseStreamCommand`:

```typescript
import { InvokeModelWithResponseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { reserveForStream } from "runcycles";

// 1. Reserve budget
const handle = await reserveForStream({ client, estimate, actionKind: "llm.completion", ... });

// 2. Stream — track usage from message_start and message_delta events
const command = new InvokeModelWithResponseStreamCommand({ modelId: MODEL, body: JSON.stringify({ ... }) });
const result = await bedrock.send(command);
for await (const event of result.body) {
  // Process chunks, accumulate input/output tokens...
}

// 3. Commit actual usage
await handle.commit(actualCost, { tokensInput, tokensOutput });
```

Bedrock streams usage in `message_start` (input tokens) and `message_delta` (output tokens) events, which must be accumulated manually.

## Testing

```bash
# Run the non-streaming example
npm run non-streaming

# Run the streaming example
npm run streaming
```
