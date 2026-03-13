/**
 * Non-streaming Anthropic Claude completion with budget governance via withCycles.
 *
 * Demonstrates:
 *   - Wrapping anthropic.messages.create() with withCycles
 *   - Extracting token counts from the Anthropic Message response
 *   - Using caps.maxTokens to limit output length
 *   - Handling BudgetExceededError
 */

import type Anthropic from "@anthropic-ai/sdk";
import {
  withCycles,
  getCyclesContext,
  BudgetExceededError,
} from "runcycles";
import {
  cyclesClient,
  anthropic,
  calculateCostMicrocents,
  estimateInputTokens,
} from "./shared.js";

const MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TOKENS = 1024;

const callClaude = withCycles(
  {
    client: cyclesClient,
    actionKind: "llm.completion",
    actionName: MODEL,
    estimate: (messages: Anthropic.MessageCreateParams["messages"]) => {
      const inputTokens = estimateInputTokens(messages);
      return calculateCostMicrocents(MODEL, inputTokens, DEFAULT_MAX_TOKENS);
    },
    actual: (response: Anthropic.Message) => {
      return calculateCostMicrocents(
        MODEL,
        response.usage.input_tokens,
        response.usage.output_tokens,
      );
    },
  },
  async (messages: Anthropic.MessageCreateParams["messages"]) => {
    const ctx = getCyclesContext();

    // Respect budget caps — if the budget system suggests a lower max_tokens,
    // use it to avoid overspending.
    let maxTokens = DEFAULT_MAX_TOKENS;
    if (ctx?.caps?.maxTokens) {
      maxTokens = Math.min(maxTokens, ctx.caps.maxTokens);
    }

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      messages,
    });

    // Report actual metrics.
    if (ctx) {
      ctx.metrics = {
        tokensInput: response.usage.input_tokens,
        tokensOutput: response.usage.output_tokens,
        modelVersion: response.model,
      };
    }

    return response;
  },
);

async function main() {
  try {
    const messages: Anthropic.MessageCreateParams["messages"] = [
      { role: "user", content: "What is budget governance for AI applications?" },
    ];

    const response = await callClaude(messages);
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    console.log("Response:", text);
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
