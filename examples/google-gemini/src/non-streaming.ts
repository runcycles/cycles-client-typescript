/**
 * Non-streaming Google Gemini completion with budget governance via withCycles.
 *
 * Demonstrates:
 *   - Wrapping model.generateContent() with withCycles
 *   - Extracting token counts from response.usageMetadata
 *   - Using caps.maxTokens to limit output length
 *   - Handling BudgetExceededError
 */

import {
  withCycles,
  getCyclesContext,
  BudgetExceededError,
} from "runcycles";
import type { GenerateContentResult } from "@google/generative-ai";
import {
  cyclesClient,
  genAI,
  calculateCostMicrocents,
  estimateInputTokens,
} from "./shared.js";

const MODEL_NAME = "gemini-2.0-flash";
const DEFAULT_MAX_TOKENS = 1024;

const callGemini = withCycles(
  {
    client: cyclesClient,
    actionKind: "llm.completion",
    actionName: MODEL_NAME,
    estimate: (prompt: string) => {
      const inputTokens = estimateInputTokens(prompt);
      return calculateCostMicrocents(MODEL_NAME, inputTokens, DEFAULT_MAX_TOKENS);
    },
    actual: (result: GenerateContentResult) => {
      const usage = result.response.usageMetadata;
      return calculateCostMicrocents(
        MODEL_NAME,
        usage?.promptTokenCount ?? 0,
        usage?.candidatesTokenCount ?? 0,
      );
    },
  },
  async (prompt: string) => {
    const ctx = getCyclesContext();

    // Respect budget caps — if the budget system suggests a lower max_tokens,
    // use it to avoid overspending.
    let maxTokens = DEFAULT_MAX_TOKENS;
    if (ctx?.caps?.maxTokens) {
      maxTokens = Math.min(maxTokens, ctx.caps.maxTokens);
    }

    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: { maxOutputTokens: maxTokens },
    });

    const result = await model.generateContent(prompt);

    // Report actual metrics.
    if (ctx) {
      const usage = result.response.usageMetadata;
      ctx.metrics = {
        tokensInput: usage?.promptTokenCount,
        tokensOutput: usage?.candidatesTokenCount,
        modelVersion: MODEL_NAME,
      };
    }

    return result;
  },
);

async function main() {
  try {
    const result = await callGemini("What is budget governance for AI applications?");
    const text = result.response.text();

    console.log("Response:", text);
    console.log("Usage:", result.response.usageMetadata);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.error("Budget exhausted:", err.message);
    } else {
      throw err;
    }
  }
}

main().catch(console.error);
