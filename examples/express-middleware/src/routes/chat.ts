/**
 * Streaming chat route that uses the Cycles middleware handle.
 *
 * The cyclesGuard middleware has already reserved budget and attached
 * the handle to res.locals.cyclesHandle. This route starts streaming,
 * and commits actual usage when the stream finishes.
 */

import { Router, type Request, type Response } from "express";
import OpenAI from "openai";

const openai = new OpenAI();
const router = Router();

router.post("/", async (req: Request, res: Response) => {
  const handle = res.locals.cyclesHandle;
  if (!handle) {
    res.status(500).json({ error: "Missing Cycles reservation handle" });
    return;
  }

  const { messages } = req.body as { messages: OpenAI.ChatCompletionMessageParam[] };

  // Set SSE headers for streaming.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });

    let usage: OpenAI.CompletionUsage | undefined;
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();

    // Commit actual usage after the stream completes.
    const inputCost = (usage?.prompt_tokens ?? 0) * 250;
    const outputCost = (usage?.completion_tokens ?? 0) * 1000;
    await handle.commit(Math.ceil(inputCost + outputCost), {
      tokensInput: usage?.prompt_tokens,
      tokensOutput: usage?.completion_tokens,
      modelVersion: "gpt-4o",
    });
  } catch (err) {
    if (!handle.finalized) {
      await handle.release("stream_error");
    }
    if (!res.headersSent) {
      res.status(500).json({ error: "Stream failed" });
    } else {
      res.end();
    }
  }
});

export default router;
