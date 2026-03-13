/**
 * Express server with Cycles budget governance middleware.
 *
 * Demonstrates two patterns on the same server:
 *   - /api/chat    — streaming route protected by cyclesGuard middleware
 *   - /api/summarize — non-streaming route using withCycles inline
 *   - /api/balance — observability endpoint showing current budget balances
 */

import express from "express";
import { CyclesClient, CyclesConfig } from "runcycles";
import { cyclesGuard } from "./middleware/cycles-guard.js";
import chatRoute from "./routes/chat.js";
import summarizeRoute from "./routes/summarize.js";

const app = express();
app.use(express.json());

const cyclesClient = new CyclesClient(CyclesConfig.fromEnv());

// Streaming chat route — protected by Cycles middleware.
// The middleware reserves budget and attaches the handle to res.locals.
app.use(
  "/api/chat",
  cyclesGuard({
    client: cyclesClient,
    actionKind: "llm.completion",
    actionName: "gpt-4o",
    estimateFn: (req) => {
      const messages = req.body?.messages ?? [];
      const chars = messages.reduce(
        (sum: number, m: { content?: string }) =>
          sum + (typeof m.content === "string" ? m.content.length : 0),
        0,
      );
      const inputTokens = Math.ceil(chars / 4);
      return Math.ceil(inputTokens * 250 + inputTokens * 2 * 1000);
    },
  }),
  chatRoute,
);

// Non-streaming summarization route — uses withCycles inline (no middleware).
app.use("/api/summarize", summarizeRoute);

// Observability endpoint — query current budget balances.
app.get("/api/balance", async (_req, res) => {
  const balances = await cyclesClient.getBalances({
    tenant: cyclesClient.config.tenant!,
  });
  res.json(balances.body);
});

const port = process.env.PORT ?? 3000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log("Routes:");
  console.log("  POST /api/chat       — streaming chat (cyclesGuard middleware)");
  console.log("  POST /api/summarize  — summarization (withCycles inline)");
  console.log("  GET  /api/balance    — budget balances");
});
