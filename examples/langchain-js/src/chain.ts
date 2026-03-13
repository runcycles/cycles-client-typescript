/**
 * LangChain.js chain with budget governance via withCycles.
 *
 * Demonstrates:
 *   - Wrapping a LangChain prompt + LLM chain with withCycles
 *   - Extracting token usage from LangChain's response metadata
 *   - Reporting metrics via getCyclesContext()
 */

import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  withCycles,
  getCyclesContext,
  BudgetExceededError,
} from "runcycles";
import { cyclesClient, calculateCostMicrocents } from "./shared.js";

const MODEL = "gpt-4o";

const model = new ChatOpenAI({ model: MODEL });
const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You are a helpful assistant that explains concepts clearly."],
  ["user", "{question}"],
]);
const chain = prompt.pipe(model);

const askQuestion = withCycles(
  {
    client: cyclesClient,
    actionKind: "llm.completion",
    actionName: MODEL,
    estimate: (question: string) => {
      // Estimate tokens from the question + system prompt.
      const inputTokens = Math.ceil((question.length + 60) / 4);
      return calculateCostMicrocents(MODEL, inputTokens, inputTokens * 2);
    },
    actual: (_result: string, _question: string) => {
      // Actual cost is set via getCyclesContext() inside the function,
      // so we return 0 here and let the context handle it.
      const ctx = getCyclesContext();
      return ctx?.actualOverride ?? 0;
    },
  },
  async (question: string) => {
    const ctx = getCyclesContext();

    // Invoke the chain. LangChain returns an AIMessage with response_metadata.
    const response = await chain.invoke({ question });

    // Extract token usage from LangChain's response metadata.
    const usage = response.response_metadata?.tokenUsage as
      | { promptTokens?: number; completionTokens?: number }
      | undefined;

    if (ctx && usage) {
      const inputTokens = usage.promptTokens ?? 0;
      const outputTokens = usage.completionTokens ?? 0;
      ctx.metrics = {
        tokensInput: inputTokens,
        tokensOutput: outputTokens,
        modelVersion: MODEL,
      };
      // Store actual cost for the actual() callback.
      (ctx as Record<string, unknown>).actualOverride =
        calculateCostMicrocents(MODEL, inputTokens, outputTokens);
    }

    // Parse the content to a string.
    const parser = new StringOutputParser();
    return parser.invoke(response);
  },
);

async function main() {
  try {
    const result = await askQuestion("What is budget governance for AI?");
    console.log("Answer:", result);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.error("Budget exhausted:", err.message);
    } else {
      throw err;
    }
  }
}

main().catch(console.error);
