/**
 * Shared initialization and cost helpers for the OpenAI SDK examples.
 */

import OpenAI from "openai";
import { CyclesClient, CyclesConfig } from "runcycles";

// Initialize the Cycles client from environment variables.
export const cyclesClient = new CyclesClient(CyclesConfig.fromEnv());

// Initialize the OpenAI client (reads OPENAI_API_KEY from env).
export const openai = new OpenAI();

/**
 * Per-token pricing in USD microcents for common OpenAI models.
 * 1 USD microcent = 1/1,000,000 of a cent = 1/100,000,000 of a dollar.
 *
 * Example: GPT-4o input at $2.50/1M tokens = 250 microcents/token.
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o":      { input: 250, output: 1000 },
  "gpt-4o-mini": { input: 15,  output: 60 },
  "gpt-4-turbo": { input: 1000, output: 3000 },
  "o1":          { input: 1500, output: 6000 },
  "o1-mini":     { input: 300,  output: 1200 },
};

/** Calculate cost in USD microcents for a given model and token counts. */
export function calculateCostMicrocents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["gpt-4o"]!;
  return Math.ceil(inputTokens * pricing.input + outputTokens * pricing.output);
}

/** Rough token estimate from message content (1 token ~ 4 chars). */
export function estimateInputTokens(
  messages: OpenAI.ChatCompletionMessageParam[],
): number {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === "string" ? m.content : "";
    return sum + Math.ceil(content.length / 4);
  }, 0);
}
