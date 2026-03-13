/**
 * LangChain.js ReAct agent with budget governance via reserveForStream.
 *
 * Demonstrates:
 *   - Reserving budget for a multi-step agent run
 *   - Using Caps to limit agent iterations and filter tools
 *   - Accumulating token usage across multiple agent steps
 *   - Committing aggregate cost after the agent finishes
 */

import { ChatOpenAI } from "@langchain/openai";
import { DynamicTool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { reserveForStream, BudgetExceededError, isToolAllowed } from "runcycles";
import { cyclesClient, calculateCostMicrocents } from "./shared.js";

const MODEL = "gpt-4o";

// Define tools for the agent.
const allTools = [
  new DynamicTool({
    name: "calculator",
    description: "Evaluates a math expression. Input: a math expression string.",
    func: async (input: string) => {
      try {
        // Simple eval for demo purposes — use a proper math parser in production.
        const result = new Function(`return (${input})`)();
        return String(result);
      } catch {
        return "Error: invalid expression";
      }
    },
  }),
  new DynamicTool({
    name: "current_date",
    description: "Returns the current date and time.",
    func: async () => new Date().toISOString(),
  }),
];

async function main() {
  // Estimate a higher budget for agent runs — agents make multiple LLM calls.
  const estimatedCost = calculateCostMicrocents(MODEL, 2000, 4000);

  // 1. Reserve budget — throws BudgetExceededError if exhausted.
  //    No cleanup needed on failure (no handle exists yet).
  let handle;
  try {
    handle = await reserveForStream({
      client: cyclesClient,
      estimate: estimatedCost,
      unit: "USD_MICROCENTS",
      actionKind: "agent.run",
      actionName: "react-agent",
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.error("Budget exhausted:", err.message);
      return;
    }
    throw err;
  }

  // 2. Run the agent — release the reservation if anything fails.
  try {
    // Filter tools based on budget caps (toolAllowlist).
    let tools = allTools;
    if (handle.caps) {
      tools = allTools.filter((tool) => isToolAllowed(handle.caps!, tool.name));
    }

    // Create the ReAct agent with the (possibly filtered) tools.
    const model = new ChatOpenAI({ model: MODEL });
    const agent = createReactAgent({ llm: model, tools });

    // Run the agent.
    const result = await agent.invoke({
      messages: [
        { role: "user", content: "What is 42 * 17? Also, what is today's date?" },
      ],
    });

    // Extract the final response.
    const lastMessage = result.messages[result.messages.length - 1];
    console.log("Agent result:", lastMessage.content);

    // Accumulate token usage across all LLM steps.
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const msg of result.messages) {
      const usage = msg.response_metadata?.tokenUsage as
        | { promptTokens?: number; completionTokens?: number }
        | undefined;
      if (usage) {
        totalInputTokens += usage.promptTokens ?? 0;
        totalOutputTokens += usage.completionTokens ?? 0;
      }
    }

    // 3. Commit aggregate cost.
    const actualCost = calculateCostMicrocents(MODEL, totalInputTokens, totalOutputTokens);
    await handle.commit(actualCost, {
      tokensInput: totalInputTokens,
      tokensOutput: totalOutputTokens,
      modelVersion: MODEL,
    });
    console.log("\nCommitted:", {
      actualCost,
      totalInputTokens,
      totalOutputTokens,
      steps: result.messages.length,
    });
  } catch (err) {
    await handle.release("agent_error");
    throw err;
  }
}

main().catch(console.error);
