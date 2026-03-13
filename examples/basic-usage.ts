/** Basic programmatic usage of the Cycles client. */

import { CyclesClient, CyclesConfig, Unit } from "runcycles";

async function main() {
  const config = new CyclesConfig({
    baseUrl: "http://localhost:7878",
    apiKey: "your-api-key",
    tenant: "acme",
  });

  const client = new CyclesClient(config);

  // Full reserve → execute → commit lifecycle
  // The client operates on wire-format (snake_case) JSON.
  // Use *ToWire() mappers for camelCase convenience, or pass snake_case directly.
  const response = await client.createReservation({
    idempotency_key: "req-001",
    subject: { tenant: "acme", agent: "support-bot" },
    action: { kind: "llm.completion", name: "gpt-4" },
    estimate: { unit: Unit.USD_MICROCENTS, amount: 500_000 },
    ttl_ms: 30_000,
  });

  console.log(`Reservation: success=${response.isSuccess}, body=${JSON.stringify(response.body)}`);

  if (!response.isSuccess) {
    console.log(`Failed: ${response.errorMessage}`);
    return;
  }

  const reservationId = response.getBodyAttribute("reservation_id") as string;
  console.log(`Reserved: ${reservationId}`);

  // Simulate work
  const result = "Generated response text";

  // Commit actual usage
  const commitResponse = await client.commitReservation(reservationId, {
    idempotency_key: "commit-001",
    actual: { unit: Unit.USD_MICROCENTS, amount: 420_000 },
    metrics: {
      tokens_input: 1200,
      tokens_output: 800,
      latency_ms: 150,
      model_version: "gpt-4-0613",
    },
  });
  console.log(`Commit: success=${commitResponse.isSuccess}, body=${JSON.stringify(commitResponse.body)}`);

  // Query balances
  const balances = await client.getBalances({ tenant: "acme" });
  console.log(`Balances: ${JSON.stringify(balances.body)}`);
}

main().catch(console.error);
