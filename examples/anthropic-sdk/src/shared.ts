/**
 * Shared initialization and cost helpers for the Anthropic SDK examples.
 */

import Anthropic from "@anthropic-ai/sdk";
import { CyclesClient, CyclesConfig } from "runcycles";

// Initialize the Cycles client from environment variables.
export const cyclesClient = new CyclesClient(CyclesConfig.fromEnv());

// Initialize the Anthropic client (reads ANTHROPIC_API_KEY from env).
export const anthropic = new Anthropic();

/**
 * Per-token pricing in USD microcents for Claude models.
 * 1 USD microcent = 1/1,000,000 of a cent = 1/100,000,000 of a dollar.
 *
 * Example: Claude Sonnet 4 input at $3/1M tokens = 300 microcents/token.
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514":   { input: 300,  output: 1500 },
  "claude-haiku-4-20250506":    { input: 100,  output: 500 },
  "claude-opus-4-20250515":     { input: 1500, output: 7500 },
};

/** Calculate cost in USD microcents for a given model and token counts. */
export function calculateCostMicrocents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  // Match by prefix to handle versioned model IDs.
  const key = Object.keys(MODEL_PRICING).find((k) => model.startsWith(k.replace(/-\d+$/, "")));
  const pricing = key ? MODEL_PRICING[key]! : MODEL_PRICING["claude-sonnet-4-20250514"]!;
  return Math.ceil(inputTokens * pricing.input + outputTokens * pricing.output);
}

/** Rough token estimate from message content (1 token ~ 4 chars). */
export function estimateInputTokens(
  messages: Anthropic.MessageCreateParams["messages"],
): number {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === "string" ? m.content : "";
    return sum + Math.ceil(content.length / 4);
  }, 0);
}
