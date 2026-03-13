import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { CommitRetryEngine } from "../src/retry.js";
import { CyclesConfig } from "../src/config.js";
import { CyclesResponse } from "../src/response.js";

describe("CommitRetryEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries on failure then succeeds", async () => {
    const config = new CyclesConfig({
      baseUrl: "http://localhost",
      apiKey: "key",
      retryMaxAttempts: 3,
      retryInitialDelay: 100,
      retryMultiplier: 2,
      retryMaxDelay: 1000,
    });

    const engine = new CommitRetryEngine(config);
    const mockClient = {
      commitReservation: vi
        .fn()
        .mockResolvedValueOnce(CyclesResponse.httpError(500, "Server error"))
        .mockResolvedValueOnce(CyclesResponse.success(200, { status: "COMMITTED" })),
    };
    engine.setClient(mockClient as any);

    engine.schedule("r-1", { idempotencyKey: "c-1", actual: { unit: "USD_MICROCENTS", amount: 100 } });

    // First retry after 100ms
    await vi.advanceTimersByTimeAsync(100);
    expect(mockClient.commitReservation).toHaveBeenCalledTimes(1);

    // Second retry after 200ms
    await vi.advanceTimersByTimeAsync(200);
    expect(mockClient.commitReservation).toHaveBeenCalledTimes(2);
  });

  it("stops on non-retryable client error", async () => {
    const config = new CyclesConfig({
      baseUrl: "http://localhost",
      apiKey: "key",
      retryMaxAttempts: 3,
      retryInitialDelay: 100,
      retryMultiplier: 2,
      retryMaxDelay: 1000,
    });

    const engine = new CommitRetryEngine(config);
    const mockClient = {
      commitReservation: vi
        .fn()
        .mockResolvedValue(CyclesResponse.httpError(400, "Bad request")),
    };
    engine.setClient(mockClient as any);

    engine.schedule("r-1", { idempotencyKey: "c-1" });

    await vi.advanceTimersByTimeAsync(100);
    expect(mockClient.commitReservation).toHaveBeenCalledTimes(1);

    // Should not retry a 400
    await vi.advanceTimersByTimeAsync(500);
    expect(mockClient.commitReservation).toHaveBeenCalledTimes(1);
  });

  it("does not schedule when disabled", () => {
    const config = new CyclesConfig({
      baseUrl: "http://localhost",
      apiKey: "key",
      retryEnabled: false,
    });

    const engine = new CommitRetryEngine(config);
    const mockClient = { commitReservation: vi.fn() };
    engine.setClient(mockClient as any);

    engine.schedule("r-1", { idempotencyKey: "c-1" });

    vi.advanceTimersByTime(10000);
    expect(mockClient.commitReservation).not.toHaveBeenCalled();
  });
});
