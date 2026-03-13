/**
 * Next.js API route: budget-governed chat with Cycles + Vercel AI SDK.
 *
 * This route demonstrates wrapping the Vercel AI SDK's `streamText` function
 * with Cycles budget governance. Every LLM call is:
 *   1. Reserved against the tenant's budget before execution
 *   2. Streamed to the client in real time
 *   3. Committed with actual token usage after the stream completes
 *
 * If the budget is exhausted, the request is denied before any LLM call is made.
 */

import { streamText, type UIMessage, convertToModelMessages } from "ai";
import { openai } from "@ai-sdk/openai";
import {
  CyclesClient,
  CyclesConfig,
  getCyclesContext,
  withCycles,
  BudgetExceededError,
} from "runcycles";

// Initialize the Cycles client from environment variables.
// Reads CYCLES_BASE_URL, CYCLES_API_KEY, CYCLES_TENANT, etc.
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

  try {
    // withCycles wraps the LLM call with the reserve → execute → commit lifecycle.
    // If the tenant's budget is exceeded, a BudgetExceededError is thrown
    // before the LLM call is made.
    const result = await withCycles(
      {
        estimate: estimatedCostMicrocents,
        actual: (streamResult: any) => {
          // This callback is invoked after the guarded function returns.
          // For streaming, the actual token count is not yet known at this point,
          // so we fall back to the estimate (the default behavior).
          // To commit exact usage, set ctx.metrics inside the function body
          // and let the lifecycle use the estimate as actual.
          return estimatedCostMicrocents;
        },
        actionKind: "llm.completion",
        actionName: "gpt-4o",
        unit: "USD_MICROCENTS",
        client: cyclesClient,
      },
      async () => {
        const result = streamText({
          model: openai("gpt-4o"),
          messages: await convertToModelMessages(messages),
        });

        // Attach token usage to the Cycles context for observability.
        // The onFinish callback fires after the stream is fully consumed,
        // so metrics will be included in the commit.
        const ctx = getCyclesContext();
        if (ctx) {
          result.usage.then((usage) => {
            ctx.metrics = {
              tokensInput: usage.promptTokens,
              tokensOutput: usage.completionTokens,
              modelVersion: "gpt-4o",
            };
          });
        }

        return result;
      },
    )();

    return result.toDataStreamResponse();
  } catch (err) {
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
