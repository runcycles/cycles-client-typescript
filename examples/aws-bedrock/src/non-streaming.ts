/**
 * Non-streaming AWS Bedrock completion with budget governance via withCycles.
 *
 * Demonstrates:
 *   - Wrapping Bedrock's InvokeModelCommand with withCycles
 *   - Extracting token counts from the Bedrock response
 *   - Using caps.maxTokens to limit output length
 *   - Handling BudgetExceededError
 */

import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  withCycles,
  getCyclesContext,
  BudgetExceededError,
} from "runcycles";
import {
  cyclesClient,
  bedrock,
  calculateCostMicrocents,
  estimateInputTokens,
} from "./shared.js";

const MODEL_ID = "anthropic.claude-sonnet-4-20250514-v1:0";
const DEFAULT_MAX_TOKENS = 1024;

interface BedrockClaudeResponse {
  content: Array<{ type: string; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

const callBedrock = withCycles(
  {
    client: cyclesClient,
    actionKind: "llm.completion",
    actionName: MODEL_ID,
    estimate: (messages: Array<{ role: string; content: string }>) => {
      const inputTokens = estimateInputTokens(messages);
      return calculateCostMicrocents(MODEL_ID, inputTokens, DEFAULT_MAX_TOKENS);
    },
    actual: (response: BedrockClaudeResponse) => {
      return calculateCostMicrocents(
        MODEL_ID,
        response.usage.input_tokens,
        response.usage.output_tokens,
      );
    },
  },
  async (messages: Array<{ role: string; content: string }>) => {
    const ctx = getCyclesContext();

    // Respect budget caps — if the budget system suggests a lower max_tokens,
    // use it to avoid overspending.
    let maxTokens = DEFAULT_MAX_TOKENS;
    if (ctx?.caps?.maxTokens) {
      maxTokens = Math.min(maxTokens, ctx.caps.maxTokens);
    }

    const command = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: maxTokens,
        messages,
      }),
    });

    const result = await bedrock.send(command);
    const response = JSON.parse(
      new TextDecoder().decode(result.body),
    ) as BedrockClaudeResponse;

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
    const messages = [
      { role: "user", content: "What is budget governance for AI applications?" },
    ];

    const response = await callBedrock(messages);
    const text = response.content
      .filter((block) => block.type === "text")
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
