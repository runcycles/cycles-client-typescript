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

  let handle;
  try {
    // Reserve budget before starting the stream.
    handle = await reserveForStream({
      client: cyclesClient,
      estimate: estimatedCost,
      unit: "USD_MICROCENTS",
      actionKind: "llm.completion",
      actionName: MODEL,
    });

    // Start streaming with usage tracking enabled.
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

    // Commit actual usage now that the stream has finished.
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
    if (handle) {
      await handle.release("stream_error");
    }
    if (err instanceof BudgetExceededError) {
      console.error("Budget exhausted:", err.message);
    } else {
      throw err;
    }
  }
}

main().catch(console.error);
