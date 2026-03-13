import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { withCycles, setDefaultClient, setDefaultConfig, _resetDefaults } from "../src/withCycles.js";
import { CyclesClient } from "../src/client.js";
import { CyclesConfig } from "../src/config.js";
import { CyclesResponse } from "../src/response.js";
import { mockFetchSequence } from "./helpers.js";

describe("withCycles", () => {
  beforeEach(() => {
    _resetDefaults();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetDefaults();
  });

  it("wraps function with budget governance", async () => {
    // Mock: createReservation -> commitReservation
    mockFetchSequence([
      {
        status: 200,
        body: {
          decision: "ALLOW",
          reservation_id: "r-1",
          affected_scopes: ["tenant:acme"],
          expires_at_ms: Date.now() + 60000,
        },
      },
      {
        status: 200,
        body: { status: "COMMITTED", charged: { unit: "USD_MICROCENTS", amount: 1000 } },
      },
    ]);

    const config = new CyclesConfig({ baseUrl: "http://localhost:7878", apiKey: "key", tenant: "acme" });
    const client = new CyclesClient(config);

    const guarded = withCycles(
      { estimate: 1000, actionKind: "llm.completion", actionName: "gpt-4", client },
      async (prompt: string) => `Response to: ${prompt}`,
    );

    const result = await guarded("Hello");
    expect(result).toBe("Response to: Hello");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses default client", async () => {
    mockFetchSequence([
      { status: 200, body: { decision: "ALLOW", reservation_id: "r-2", affected_scopes: [] } },
      { status: 200, body: { status: "COMMITTED" } },
    ]);

    const config = new CyclesConfig({ baseUrl: "http://localhost:7878", apiKey: "key", tenant: "acme" });
    setDefaultClient(new CyclesClient(config));

    const guarded = withCycles(
      { estimate: 500 },
      async () => "ok",
    );

    const result = await guarded();
    expect(result).toBe("ok");
  });

  it("uses default config to create client lazily", async () => {
    mockFetchSequence([
      { status: 200, body: { decision: "ALLOW", reservation_id: "r-3", affected_scopes: [] } },
      { status: 200, body: { status: "COMMITTED" } },
    ]);

    setDefaultConfig(new CyclesConfig({ baseUrl: "http://localhost:7878", apiKey: "key", tenant: "acme" }));

    const guarded = withCycles(
      { estimate: 500 },
      async () => "lazy",
    );

    const result = await guarded();
    expect(result).toBe("lazy");
  });

  it("throws if no client available", async () => {
    const guarded = withCycles(
      { estimate: 500 },
      async () => "never",
    );

    await expect(guarded()).rejects.toThrow("No Cycles client available");
  });

  it("supports setDefaultClient after withCycles definition", async () => {
    // Define the guarded function BEFORE setting the default client.
    // This deferred pattern must work for module-scope definitions.
    const guarded = withCycles(
      { estimate: 500 },
      async () => "deferred",
    );

    // Set default client after definition
    mockFetchSequence([
      { status: 200, body: { decision: "ALLOW", reservation_id: "r-deferred", affected_scopes: [] } },
      { status: 200, body: { status: "COMMITTED" } },
    ]);
    const config = new CyclesConfig({ baseUrl: "http://localhost:7878", apiKey: "key", tenant: "acme" });
    setDefaultClient(new CyclesClient(config));

    const result = await guarded();
    expect(result).toBe("deferred");
  });

  it("preserves function arguments", async () => {
    mockFetchSequence([
      { status: 200, body: { decision: "ALLOW", reservation_id: "r-4", affected_scopes: [] } },
      { status: 200, body: { status: "COMMITTED" } },
    ]);

    const config = new CyclesConfig({ baseUrl: "http://localhost:7878", apiKey: "key", tenant: "acme" });
    const client = new CyclesClient(config);

    const fn = vi.fn().mockResolvedValue("done");
    const guarded = withCycles({ estimate: 100, client }, fn);

    await guarded("arg1", 42);
    expect(fn).toHaveBeenCalledWith("arg1", 42);
  });
});
