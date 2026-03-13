/**
 * Next.js API route: budget-governed chat with Cycles + Vercel AI SDK.
 *
 * This route demonstrates the streaming adapter pattern:
 *   1. Reserve budget before starting the stream
 *   2. Keep the reservation alive via heartbeat while the stream is open
 *   3. Commit actual token usage when the stream finishes (onFinish)
 *   4. Release the reservation if streaming fails or is aborted
 *
 * If the budget is exhausted, the request is denied before any LLM call is made.
 *
 * Requires Node.js runtime (for AsyncLocalStorage).
 */

import { streamText, type UIMessage, convertToModelMessages } from "ai";
import { openai } from "@ai-sdk/openai";
import {
  CyclesClient,
  CyclesConfig,
  reserveForStream,
  BudgetExceededError,
} from "runcycles";

// Force Node.js runtime (required for node:async_hooks / AsyncLocalStorage).
export const runtime = "nodejs";

// Initialize the Cycles client from environment variables.
const cyclesClient = new CyclesClient(CyclesConfig.fromEnv());

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  // Rough token estimate from message content length (1 token ≈ 4 chars).
  // In production, use a proper tokenizer like tiktoken.
  const estimatedInputTokens = messages.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0) / 4,
    0,
  );

  // Estimate cost in USD microcents.
  // Example: GPT-4o input ≈ $2.50/1M tokens = 250 microcents/token
  //          GPT-4o output ≈ $10/1M tokens = 1000 microcents/token
  // Estimate assumes 2x input tokens as output.
  const estimatedCostMicrocents = Math.ceil(
    estimatedInputTokens * 250 + estimatedInputTokens * 2 * 1000,
  );

  let handle;
  try {
    // Reserve budget before starting the stream.
    // Throws BudgetExceededError if the tenant's budget is exhausted.
    // Subject defaults (tenant, etc.) are read from cyclesClient.config
    // automatically, so there's no need to pass them explicitly.
    handle = await reserveForStream({
      client: cyclesClient,
      estimate: estimatedCostMicrocents,
      unit: "USD_MICROCENTS",
      actionKind: "llm.completion",
      actionName: "gpt-4o",
    });

    // Start the stream. The reservation heartbeat keeps it alive
    // while tokens are being generated.
    const result = streamText({
      model: openai("gpt-4o"),
      messages: await convertToModelMessages(messages),
      onFinish: async ({ usage }) => {
        // Commit actual usage once the stream completes.
        // commit() automatically stops the heartbeat.
        const actualCost = Math.ceil(
          (usage.promptTokens ?? 0) * 250 +
          (usage.completionTokens ?? 0) * 1000,
        );
        await handle!.commit(actualCost, {
          tokensInput: usage.promptTokens,
          tokensOutput: usage.completionTokens,
          modelVersion: "gpt-4o",
        });
      },
    });

    return result.toDataStreamResponse();
  } catch (err) {
    // Release the reservation if we fail before or during streaming.
    // release() automatically stops the heartbeat.
    if (handle) {
      await handle.release("stream_error");
    }

    if (err instanceof BudgetExceededError) {
      return new Response(
        JSON.stringify({
          error: "budget_exceeded",
          message: "Your budget has been exhausted. Please contact your administrator.",
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      );
    }
    throw err;
  }
}
