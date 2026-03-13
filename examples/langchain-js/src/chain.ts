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
import type { AIMessage } from "@langchain/core/messages";
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

/** Helper to extract token usage from a LangChain AIMessage. */
function getTokenUsage(response: AIMessage) {
  const usage = response.response_metadata?.tokenUsage as
    | { promptTokens?: number; completionTokens?: number }
    | undefined;
  return {
    inputTokens: usage?.promptTokens ?? 0,
    outputTokens: usage?.completionTokens ?? 0,
  };
}

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
    actual: (response: AIMessage) => {
      const { inputTokens, outputTokens } = getTokenUsage(response);
      return calculateCostMicrocents(MODEL, inputTokens, outputTokens);
    },
  },
  async (question: string) => {
    const ctx = getCyclesContext();

    // Invoke the chain. LangChain returns an AIMessage with response_metadata.
    const response = await chain.invoke({ question });

    // Report token metrics.
    if (ctx) {
      const { inputTokens, outputTokens } = getTokenUsage(response);
      ctx.metrics = {
        tokensInput: inputTokens,
        tokensOutput: outputTokens,
        modelVersion: MODEL,
      };
    }

    // Return the AIMessage so the actual() callback can extract usage.
    return response;
  },
);

async function main() {
  try {
    const response = await askQuestion("What is budget governance for AI?");
    // The response is an AIMessage — extract the text content.
    const text = typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);
    console.log("Answer:", text);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.error("Budget exhausted:", err.message);
    } else {
      throw err;
    }
  }
}

main().catch(console.error);
