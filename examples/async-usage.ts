/** Async usage of the Cycles client with withCycles. */

import { CyclesClient, CyclesConfig, withCycles, getCyclesContext } from "runcycles";

const config = new CyclesConfig({
  baseUrl: "http://localhost:7878",
  apiKey: "your-api-key",
  tenant: "acme",
});
const client = new CyclesClient(config);

const callLlm = withCycles(
  {
    estimate: (prompt: string) => prompt.length * 10,
    actual: (result: string) => result.length * 5,
    actionKind: "llm.completion",
    actionName: "gpt-4",
    client,
  },
  async (prompt: string) => {
    const ctx = getCyclesContext();
    if (ctx) {
      console.log(`  Reservation: ${ctx.reservationId}`);
      ctx.metrics = { tokensInput: 100, tokensOutput: 50 };
    }

    // Simulate async LLM call
    await new Promise((r) => setTimeout(r, 100));
    return `Response to: ${prompt}`;
  },
);

async function main() {
  const result = await callLlm("Hello, world!");
  console.log(`Result: ${result}`);
}

main().catch(console.error);
