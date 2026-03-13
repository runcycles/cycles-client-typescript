/**
 * Non-streaming summarization route using withCycles directly.
 *
 * This route does NOT use the cyclesGuard middleware — it demonstrates
 * that withCycles can be used inline for simpler, non-streaming calls.
 */

import { Router, type Request, type Response } from "express";
import OpenAI from "openai";
import {
  CyclesClient,
  CyclesConfig,
  withCycles,
  getCyclesContext,
  BudgetExceededError,
} from "runcycles";

const openai = new OpenAI();
const cyclesClient = new CyclesClient(CyclesConfig.fromEnv());

const summarize = withCycles(
  {
    client: cyclesClient,
    actionKind: "llm.completion",
    actionName: "gpt-4o-mini",
    estimate: (text: string) => {
      const inputTokens = Math.ceil(text.length / 4);
      return Math.ceil(inputTokens * 15 + 200 * 60); // gpt-4o-mini pricing
    },
    actual: (response: OpenAI.ChatCompletion) => {
      const usage = response.usage;
      return Math.ceil(
        (usage?.prompt_tokens ?? 0) * 15 +
        (usage?.completion_tokens ?? 0) * 60,
      );
    },
  },
  async (text: string) => {
    const ctx = getCyclesContext();
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Summarize the following text in 2-3 sentences." },
        { role: "user", content: text },
      ],
    });
    if (ctx && response.usage) {
      ctx.metrics = {
        tokensInput: response.usage.prompt_tokens,
        tokensOutput: response.usage.completion_tokens,
        modelVersion: response.model,
      };
    }
    return response;
  },
);

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  try {
    const { text } = req.body as { text: string };
    const response = await summarize(text);
    res.json({
      summary: response.choices[0]?.message.content,
      usage: response.usage,
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      res.status(402).json({
        error: "budget_exceeded",
        message: "Your budget has been exhausted.",
      });
      return;
    }
    throw err;
  }
});

export default router;
