/**
 * Shared initialization and cost helpers for the AWS Bedrock examples.
 */

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { CyclesClient, CyclesConfig } from "runcycles";

// Initialize the Cycles client from environment variables.
export const cyclesClient = new CyclesClient(CyclesConfig.fromEnv());

// Initialize the Bedrock client (reads AWS credentials from env or IAM role).
export const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION ?? "us-east-1",
});

/**
 * Per-token pricing in USD microcents for Bedrock models.
 * 1 USD microcent = 1/1,000,000 of a cent = 1/100,000,000 of a dollar.
 *
 * Example: Claude Sonnet 4 on Bedrock input at $3/1M tokens = 300 microcents/token.
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "anthropic.claude-sonnet-4-20250514-v1:0":  { input: 300,  output: 1500 },
  "anthropic.claude-haiku-4-20250506-v1:0":   { input: 100,  output: 500 },
  "anthropic.claude-opus-4-20250515-v1:0":    { input: 1500, output: 7500 },
  "amazon.titan-text-express-v1":             { input: 20,   output: 60 },
  "amazon.titan-text-premier-v1:0":           { input: 50,   output: 150 },
};

/** Calculate cost in USD microcents for a given model and token counts. */
export function calculateCostMicrocents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const key = Object.keys(MODEL_PRICING).find((k) => model.startsWith(k.replace(/-v\d+:\d+$/, "")));
  const pricing = key ? MODEL_PRICING[key]! : MODEL_PRICING["anthropic.claude-sonnet-4-20250514-v1:0"]!;
  return Math.ceil(inputTokens * pricing.input + outputTokens * pricing.output);
}

/** Rough token estimate from message content (1 token ~ 4 chars). */
export function estimateInputTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
}
