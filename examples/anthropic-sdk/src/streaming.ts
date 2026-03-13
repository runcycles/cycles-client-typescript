/**
 * Streaming Anthropic Claude completion with budget governance via reserveForStream.
 *
 * Demonstrates:
 *   - Reserving budget before the stream starts
 *   - Using anthropic.messages.stream() with the high-level helper
 *   - Extracting usage from stream.finalMessage() after the stream ends
 *   - Committing actual cost after the stream finishes
 *   - Releasing on error
 */

import type Anthropic from "@anthropic-ai/sdk";
import { reserveForStream, BudgetExceededError } from "runcycles";
import {
  cyclesClient,
  anthropic,
  calculateCostMicrocents,
  estimateInputTokens,
} from "./shared.js";

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 1024;

async function main() {
  const messages: Anthropic.MessageCreateParams["messages"] = [
    { role: "user", content: "Explain how budget governance works for AI applications." },
  ];

  const estimatedInputTokens = estimateInputTokens(messages);
  const estimatedCost = calculateCostMicrocents(
    MODEL,
    estimatedInputTokens,
    MAX_TOKENS,
  );

  // 1. Reserve budget — throws BudgetExceededError if exhausted.
  //    No cleanup needed on failure (no handle exists yet).
  let handle;
  try {
    handle = await reserveForStream({
      client: cyclesClient,
      estimate: estimatedCost,
      unit: "USD_MICROCENTS",
      actionKind: "llm.completion",
      actionName: MODEL,
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

    // Start the stream using Anthropic's high-level helper.
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      messages,
    });

    // Print content as it arrives.
    stream.on("text", (text) => {
      process.stdout.write(text);
    });

    // Wait for the stream to complete and get the final message with usage.
    const finalMessage = await stream.finalMessage();
    console.log(); // newline after streamed content

    // 3. Commit actual usage.
    const actualCost = calculateCostMicrocents(
      MODEL,
      finalMessage.usage.input_tokens,
      finalMessage.usage.output_tokens,
    );
    await handle.commit(actualCost, {
      tokensInput: finalMessage.usage.input_tokens,
      tokensOutput: finalMessage.usage.output_tokens,
      modelVersion: finalMessage.model,
    });
    console.log("\nCommitted:", {
      actualCost,
      usage: finalMessage.usage,
    });
  } catch (err) {
    await handle.release("stream_error");
    throw err;
  }
}

main().catch(console.error);
