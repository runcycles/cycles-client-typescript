/**
 * Shared initialization and cost helpers for the LangChain.js examples.
 */

import { CyclesClient, CyclesConfig } from "runcycles";

// Initialize the Cycles client from environment variables.
export const cyclesClient = new CyclesClient(CyclesConfig.fromEnv());

/**
 * Per-token pricing in USD microcents for OpenAI models used via LangChain.
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o":      { input: 250, output: 1000 },
  "gpt-4o-mini": { input: 15,  output: 60 },
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
