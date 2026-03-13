# Cycles + LangChain.js Example

Budget-governed LLM chains and agents using [LangChain.js](https://github.com/langchain-ai/langchainjs) with [Cycles](https://runcycles.com).

Two scripts demonstrate budget governance for different LangChain patterns:

- **Chain** (`withCycles`) — wraps a prompt + LLM chain and commits token usage from LangChain's `response_metadata`
- **Agent** (`reserveForStream`) — reserves budget for a multi-step ReAct agent, uses Caps to filter tools and limit iterations, and commits aggregate token usage

Every LLM call is:

1. **Reserved** against the tenant's budget before the operation starts
2. **Executed** with automatic heartbeat keeping the reservation alive (agent runs)
3. **Committed** with actual token usage accumulated across all steps
4. **Released** if the operation fails

If the budget is exhausted, the request is denied with a `BudgetExceededError` before any LLM call is made.

## Requirements

- **Node.js 20+**
- An OpenAI API key (used via LangChain's OpenAI integration)
- A running Cycles server

## Setup

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env

# Run the chain example
npm run chain

# Run the agent example
npm run agent
```

## Environment Variables

| Variable | Description |
|---|---|
| `CYCLES_BASE_URL` | Cycles server URL (e.g. `http://localhost:7878`) |
| `CYCLES_API_KEY` | Your Cycles API key |
| `CYCLES_TENANT` | Default tenant for budget scoping |
| `OPENAI_API_KEY` | Your OpenAI API key |

## How It Works

### Chain (`src/chain.ts`)

Uses `withCycles` to wrap a LangChain prompt template + LLM chain:

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { withCycles, getCyclesContext } from "runcycles";

const chain = prompt.pipe(model);

const askQuestion = withCycles(
  {
    client: cyclesClient,
    actionKind: "llm.completion",
    actionName: "gpt-4o",
    estimate: (question: string) => calculateCostMicrocents(MODEL, ...),
    actual: (response: AIMessage) => {
      // Extract actual cost from the LangChain response
      const usage = response.response_metadata?.tokenUsage;
      return calculateCostMicrocents(MODEL, usage.promptTokens, usage.completionTokens);
    },
  },
  async (question: string) => {
    const response = await chain.invoke({ question });
    const ctx = getCyclesContext();
    if (ctx) {
      const usage = response.response_metadata?.tokenUsage;
      ctx.metrics = { tokensInput: usage.promptTokens, tokensOutput: usage.completionTokens };
    }
    return response; // Return AIMessage so actual() can extract usage
  },
);
```

### Agent (`src/agent.ts`)

Uses `reserveForStream` for multi-step agent runs with Caps integration:

```typescript
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { reserveForStream, isToolAllowed } from "runcycles";

// 1. Reserve budget (higher estimate for multi-step runs)
const handle = await reserveForStream({ client, estimate, actionKind: "agent.run" });

// 2. Filter tools based on budget caps
let tools = allTools;
if (handle.caps) {
  tools = allTools.filter((tool) => isToolAllowed(handle.caps!, tool.name));
}

// 3. Run the agent
const agent = createReactAgent({ llm: model, tools });
const result = await agent.invoke({ messages });

// 4. Accumulate token usage across all agent steps and commit
let totalInput = 0, totalOutput = 0;
for (const msg of result.messages) {
  const usage = msg.response_metadata?.tokenUsage;
  if (usage) { totalInput += usage.promptTokens; totalOutput += usage.completionTokens; }
}
await handle.commit(calculateCost(totalInput, totalOutput), metrics);
```

The agent example is unique because:
- Agent runs make multiple LLM calls, so token usage must be accumulated across all steps
- Cycles `Caps` can dynamically constrain the agent by filtering available tools via `isToolAllowed()`
- The heartbeat keeps the reservation alive during potentially long agent runs

## Testing

```bash
# Run the chain example
npm run chain

# Run the agent example
npm run agent
```
