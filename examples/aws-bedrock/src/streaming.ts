/**
 * Streaming AWS Bedrock completion with budget governance via reserveForStream.
 *
 * Demonstrates:
 *   - Reserving budget before the stream starts
 *   - Using InvokeModelWithResponseStreamCommand for streaming
 *   - Accumulating token usage from stream events
 *   - Committing actual cost after the stream finishes
 *   - Releasing on error
 */

import { InvokeModelWithResponseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { reserveForStream, BudgetExceededError } from "runcycles";
import {
  cyclesClient,
  bedrock,
  calculateCostMicrocents,
  estimateInputTokens,
} from "./shared.js";

const MODEL_ID = "anthropic.claude-sonnet-4-20250514-v1:0";
const MAX_TOKENS = 1024;

async function main() {
  const messages = [
    { role: "user", content: "Explain how budget governance works for AI applications." },
  ];

  const estimatedInputTokens = estimateInputTokens(messages);
  const estimatedCost = calculateCostMicrocents(
    MODEL_ID,
    estimatedInputTokens,
    MAX_TOKENS,
  );

  // 1. Reserve budget — throws BudgetExceededError if exhausted.
  let handle;
  try {
    handle = await reserveForStream({
      client: cyclesClient,
      estimate: estimatedCost,
      unit: "USD_MICROCENTS",
      actionKind: "llm.completion",
      actionName: MODEL_ID,
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.error("Budget exhausted:", err.message);
      return;
    }
    throw err;
  }

  // 2. Stream — release the reservation if anything fails.
  try {
    // Respect budget caps for max_tokens.
    let maxTokens = MAX_TOKENS;
    if (handle.caps?.maxTokens) {
      maxTokens = Math.min(maxTokens, handle.caps.maxTokens);
    }

    const command = new InvokeModelWithResponseStreamCommand({
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

    // Track usage from stream events.
    let inputTokens = 0;
    let outputTokens = 0;

    if (result.body) {
      for await (const event of result.body) {
        if (event.chunk?.bytes) {
          const chunk = JSON.parse(
            new TextDecoder().decode(event.chunk.bytes),
          ) as Record<string, unknown>;

          if (chunk.type === "content_block_delta") {
            const delta = chunk.delta as { type: string; text?: string } | undefined;
            if (delta?.text) {
              process.stdout.write(delta.text);
            }
          }

          // Bedrock streams usage in message_start and message_delta events.
          if (chunk.type === "message_start") {
            const message = chunk.message as { usage?: { input_tokens: number } } | undefined;
            if (message?.usage) {
              inputTokens = message.usage.input_tokens;
            }
          }
          if (chunk.type === "message_delta") {
            const usage = chunk.usage as { output_tokens?: number } | undefined;
            if (usage?.output_tokens) {
              outputTokens = usage.output_tokens;
            }
          }
        }
      }
    }
    console.log(); // newline after streamed content

    // 3. Commit actual usage.
    const actualCost = calculateCostMicrocents(MODEL_ID, inputTokens, outputTokens);
    await handle.commit(actualCost, {
      tokensInput: inputTokens,
      tokensOutput: outputTokens,
      modelVersion: MODEL_ID,
    });
    console.log("\nCommitted:", {
      actualCost,
      usage: { inputTokens, outputTokens },
    });
  } catch (err) {
    await handle.release("stream_error");
    throw err;
  }
}

main().catch(console.error);
