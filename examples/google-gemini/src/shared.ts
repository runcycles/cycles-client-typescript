/**
 * Shared initialization and cost helpers for the Google Gemini examples.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { CyclesClient, CyclesConfig } from "runcycles";

// Initialize the Cycles client from environment variables.
export const cyclesClient = new CyclesClient(CyclesConfig.fromEnv());

// Initialize the Gemini client (reads GOOGLE_API_KEY from env).
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  throw new Error("GOOGLE_API_KEY environment variable is required");
}
export const genAI = new GoogleGenerativeAI(apiKey);

/**
 * Per-token pricing in USD microcents for Gemini models.
 * 1 USD microcent = 1/1,000,000 of a cent = 1/100,000,000 of a dollar.
 *
 * Pricing for prompts <= 128k tokens. See Google's pricing page for details.
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gemini-2.0-flash":     { input: 10,   output: 40 },
  "gemini-2.0-flash-lite": { input: 2,   output: 10 },
  "gemini-1.5-pro":       { input: 125,  output: 500 },
  "gemini-1.5-flash":     { input: 8,    output: 30 },
};

/** Calculate cost in USD microcents for a given model and token counts. */
export function calculateCostMicrocents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const key = Object.keys(MODEL_PRICING).find((k) => model.includes(k));
  const pricing = key ? MODEL_PRICING[key]! : MODEL_PRICING["gemini-2.0-flash"]!;
  return Math.ceil(inputTokens * pricing.input + outputTokens * pricing.output);
}

/** Rough token estimate from text content (1 token ~ 4 chars). */
export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
