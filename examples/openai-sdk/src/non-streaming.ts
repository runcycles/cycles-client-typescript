/**
 * Non-streaming OpenAI completion with budget governance via withCycles.
 *
 * Demonstrates:
 *   - Wrapping openai.chat.completions.create() with withCycles
 *   - Extracting real token counts from the OpenAI response
 *   - Reporting metrics via getCyclesContext()
 *   - Handling BudgetExceededError
 */

import type OpenAI from "openai";
import {
  withCycles,
  getCyclesContext,
  BudgetExceededError,
} from "runcycles";
import {
  cyclesClient,
  openai,
  calculateCostMicrocents,
  estimateInputTokens,
} from "./shared.js";

const MODEL = "gpt-4o";

const callLlm = withCycles(
  {
    client: cyclesClient,
    actionKind: "llm.completion",
    actionName: MODEL,
    estimate: (messages: OpenAI.ChatCompletionMessageParam[]) => {
      const inputTokens = estimateInputTokens(messages);
      // Assume output is roughly 2x the input tokens for estimation.
      return calculateCostMicrocents(MODEL, inputTokens, inputTokens * 2);
    },
    actual: (response: OpenAI.ChatCompletion) => {
      const usage = response.usage;
      return calculateCostMicrocents(
        MODEL,
        usage?.prompt_tokens ?? 0,
        usage?.completion_tokens ?? 0,
      );
    },
  },
  async (messages: OpenAI.ChatCompletionMessageParam[]) => {
    const ctx = getCyclesContext();

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
    });

    // Report actual metrics from the OpenAI response.
    if (ctx && response.usage) {
      ctx.metrics = {
        tokensInput: response.usage.prompt_tokens,
        tokensOutput: response.usage.completion_tokens,
        modelVersion: response.model,
      };
    }

    return response;
  },
);

async function main() {
  try {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is budget governance for AI?" },
    ];

    const response = await callLlm(messages);
    console.log("Response:", response.choices[0]?.message.content);
    console.log("Usage:", response.usage);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.error("Budget exhausted:", err.message);
    } else {
      throw err;
    }
  }
}

main().catch(console.error);
