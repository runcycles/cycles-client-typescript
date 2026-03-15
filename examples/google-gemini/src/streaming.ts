/**
 * Streaming Google Gemini completion with budget governance via reserveForStream.
 *
 * Demonstrates:
 *   - Reserving budget before the stream starts
 *   - Using model.generateContentStream() for streaming
 *   - Extracting usage from the aggregated response after stream ends
 *   - Committing actual cost after the stream finishes
 *   - Releasing on error
 */

import { reserveForStream, BudgetExceededError } from "runcycles";
import {
  cyclesClient,
  genAI,
  calculateCostMicrocents,
  estimateInputTokens,
} from "./shared.js";

const MODEL_NAME = "gemini-2.0-flash";
const MAX_TOKENS = 1024;

async function main() {
  const prompt = "Explain how budget governance works for AI applications.";

  const estimatedTokens = estimateInputTokens(prompt);
  const estimatedCost = calculateCostMicrocents(
    MODEL_NAME,
    estimatedTokens,
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
      actionName: MODEL_NAME,
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

    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: { maxOutputTokens: maxTokens },
    });

    const streamResult = await model.generateContentStream(prompt);

    // Print content as it arrives.
    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) {
        process.stdout.write(text);
      }
    }
    console.log(); // newline after streamed content

    // Get the aggregated response with usage metadata.
    const aggregated = await streamResult.response;
    const usage = aggregated.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;

    // 3. Commit actual usage.
    const actualCost = calculateCostMicrocents(MODEL_NAME, inputTokens, outputTokens);
    await handle.commit(actualCost, {
      tokensInput: inputTokens,
      tokensOutput: outputTokens,
      modelVersion: MODEL_NAME,
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
