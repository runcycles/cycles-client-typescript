/**
 * Integration tests against a live Cycles server.
 * Skipped unless CYCLES_BASE_URL is set.
 *
 * The nightly integration workflow starts Redis + cycles-server (7878) +
 * cycles-server-admin (7979), provisions a tenant/key/budget via the admin
 * API, and passes CYCLES_BASE_URL, CYCLES_API_KEY, CYCLES_TENANT as env vars.
 */

import { describe, it, expect } from "vitest";

const BASE_URL = process.env.CYCLES_BASE_URL;
const API_KEY = process.env.CYCLES_API_KEY;
const TENANT = process.env.CYCLES_TENANT ?? "integration-test";

const headers: Record<string, string> = {
  "X-Cycles-API-Key": API_KEY ?? "",
  "Content-Type": "application/json",
};

describe.skipIf(!BASE_URL)("Live Server Integration", () => {
  it("health check", async () => {
    const res = await fetch(`${BASE_URL}/actuator/health`);
    expect(res.status).toBe(200);
  });

  it("reservation lifecycle (reserve → commit)", async () => {
    // Reserve
    const reserve = await fetch(`${BASE_URL}/v1/reservations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        subject: { tenant: TENANT },
        action: { kind: "llm.completion", name: "test-model" },
        estimate: { unit: "USD_MICROCENTS", amount: 10000 },
        ttl_ms: 60000,
      }),
    });
    expect(reserve.status).toBe(201);
    const { reservation_id } = (await reserve.json()) as {
      reservation_id: string;
    };
    expect(reservation_id).toBeTruthy();

    // Commit
    const commit = await fetch(
      `${BASE_URL}/v1/reservations/${reservation_id}/commit`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          idempotency_key: crypto.randomUUID(),
          actual: { unit: "USD_MICROCENTS", amount: 8000 },
        }),
      }
    );
    expect(commit.status).toBe(200);
  });

  it("reserve and release", async () => {
    const reserve = await fetch(`${BASE_URL}/v1/reservations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        subject: { tenant: TENANT },
        action: { kind: "llm.completion", name: "test-model" },
        estimate: { unit: "USD_MICROCENTS", amount: 5000 },
        ttl_ms: 60000,
      }),
    });
    expect(reserve.status).toBe(201);
    const { reservation_id } = (await reserve.json()) as {
      reservation_id: string;
    };

    const release = await fetch(
      `${BASE_URL}/v1/reservations/${reservation_id}/release`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          idempotency_key: crypto.randomUUID(),
          reason: "integration-test-release",
        }),
      }
    );
    expect(release.status).toBe(200);
  });

  it("decide endpoint", async () => {
    const res = await fetch(`${BASE_URL}/v1/decide`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        subject: { tenant: TENANT },
        action: { kind: "llm.completion", name: "test-model" },
        estimate: { unit: "USD_MICROCENTS", amount: 1000 },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { decision: string };
    expect(["ALLOW", "ALLOW_WITH_CAPS", "DENY"]).toContain(data.decision);
  });

  it("balance query", async () => {
    const res = await fetch(
      `${BASE_URL}/v1/balances?tenant_id=${TENANT}`,
      { headers }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { balances: unknown[] };
    expect(data.balances).toBeDefined();
  });
});
