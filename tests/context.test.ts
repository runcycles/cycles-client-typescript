import { describe, it, expect } from "vitest";
import { getCyclesContext, runWithContext } from "../src/context.js";
import { Decision } from "../src/models.js";

describe("context", () => {
  it("returns undefined outside context", () => {
    expect(getCyclesContext()).toBeUndefined();
  });

  it("returns context inside runWithContext", () => {
    const ctx = {
      reservationId: "r-1",
      estimate: 1000,
      decision: Decision.ALLOW,
    };

    const result = runWithContext(ctx, () => {
      const inner = getCyclesContext();
      expect(inner).toBeDefined();
      expect(inner!.reservationId).toBe("r-1");
      expect(inner!.estimate).toBe(1000);
      expect(inner!.decision).toBe(Decision.ALLOW);
      return "done";
    });

    expect(result).toBe("done");
  });

  it("context is undefined after runWithContext exits", () => {
    const ctx = {
      reservationId: "r-1",
      estimate: 1000,
      decision: Decision.ALLOW,
    };

    runWithContext(ctx, () => {});
    expect(getCyclesContext()).toBeUndefined();
  });

  it("supports async functions", async () => {
    const ctx = {
      reservationId: "r-2",
      estimate: 2000,
      decision: Decision.ALLOW_WITH_CAPS,
    };

    const result = await runWithContext(ctx, async () => {
      await new Promise((r) => setTimeout(r, 10));
      const inner = getCyclesContext();
      expect(inner!.reservationId).toBe("r-2");
      return "async-done";
    });

    expect(result).toBe("async-done");
  });

  it("allows writing metrics and metadata", () => {
    const ctx = {
      reservationId: "r-3",
      estimate: 500,
      decision: Decision.ALLOW,
    };

    runWithContext(ctx, () => {
      const inner = getCyclesContext()!;
      inner.metrics = { tokensInput: 100, tokensOutput: 50 };
      inner.commitMetadata = { source: "test" };
      expect(inner.metrics.tokensInput).toBe(100);
      expect(inner.commitMetadata.source).toBe("test");
    });
  });
});
