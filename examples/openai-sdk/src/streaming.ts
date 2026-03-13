/**
 * Streaming OpenAI completion with budget governance via reserveForStream.
 *
 * Demonstrates:
 *   - Reserving budget before the stream starts
 *   - Using openai.chat.completions.create({ stream: true }) with manual iteration
 *   - Extracting token usage from the final streaming chunk
 *   - Committing actual cost after the stream finishes
 *   - Releasing on error
 */

import type OpenAI from "openai";
import { reserveForStream, BudgetExceededError } from "runcycles";
import {
  cyclesClient,
  openai,
  calculateCostMicrocents,
  estimateInputTokens,
} from "./shared.js";

const MODEL = "gpt-4o";

async function main() {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Explain how budget governance works for AI applications." },
  ];

  const estimatedInputTokens = estimateInputTokens(messages);
  const estimatedCost = calculateCostMicrocents(
    MODEL,
    estimatedInputTokens,
    estimatedInputTokens * 2,
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
    // stream_options.include_usage makes OpenAI include token counts
    // in the final chunk — without it, usage is unavailable in streams.
    const stream = await openai.chat.completions.create({
      model: MODEL,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });

    // Iterate over chunks, printing content as it arrives.
    let usage: OpenAI.CompletionUsage | undefined;
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        process.stdout.write(content);
      }
      // The final chunk carries the aggregated usage.
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }
    console.log(); // newline after streamed content

    // 3. Commit actual usage now that the stream has finished.
    const actualCost = calculateCostMicrocents(
      MODEL,
      usage?.prompt_tokens ?? 0,
      usage?.completion_tokens ?? 0,
    );
    await handle.commit(actualCost, {
      tokensInput: usage?.prompt_tokens,
      tokensOutput: usage?.completion_tokens,
      modelVersion: MODEL,
    });
    console.log("\nCommitted:", { actualCost, usage });
  } catch (err) {
    await handle.release("stream_error");
    throw err;
  }
}

main().catch(console.error);
