/** withCycles higher-order function usage. */

import { CyclesClient, CyclesConfig, withCycles, getCyclesContext } from "runcycles";

const config = new CyclesConfig({
  baseUrl: "http://localhost:7878",
  apiKey: "your-api-key",
  tenant: "acme",
  app: "chat",
});
const client = new CyclesClient(config);

// Simplest form: constant estimate used as actual
const simpleCall = withCycles(
  { estimate: 1000, client },
  async () => "Hello",
);

// With callable estimate and actual
const callLlm = withCycles(
  {
    estimate: (prompt: string, tokens: number) => tokens * 10,
    actual: (result: string) => result.length * 5,
    actionKind: "llm.completion",
    actionName: "gpt-4",
    client,
  },
  async (prompt: string, tokens: number) => {
    const ctx = getCyclesContext();
    if (ctx) {
      console.log(`  Reservation: ${ctx.reservationId}, decision: ${ctx.decision}`);
      if (ctx.caps) {
        console.log(`  Caps: maxTokens=${ctx.caps.maxTokens}`);
      }

      // Report metrics
      ctx.metrics = {
        tokensInput: tokens,
        tokensOutput: 42,
        modelVersion: "gpt-4-0613",
      };
      ctx.commitMetadata = { source: "demo" };
    }

    return "Generated response for: " + prompt;
  },
);

async function main() {
  console.log("Simple call:");
  const result1 = await simpleCall();
  console.log(`  Result: ${result1}`);

  console.log("\nLLM call with metrics:");
  const result2 = await callLlm("Tell me a joke", 200);
  console.log(`  Result: ${result2}`);
}

main().catch(console.error);
