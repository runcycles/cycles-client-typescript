import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CyclesConfig } from "../src/config.js";

describe("CyclesConfig", () => {
  it("should set defaults", () => {
    const config = new CyclesConfig({ baseUrl: "http://localhost:7878", apiKey: "key" });
    expect(config.baseUrl).toBe("http://localhost:7878");
    expect(config.apiKey).toBe("key");
    expect(config.connectTimeout).toBe(2_000);
    expect(config.readTimeout).toBe(5_000);
    expect(config.retryEnabled).toBe(true);
    expect(config.retryMaxAttempts).toBe(5);
    expect(config.tenant).toBeUndefined();
  });

  it("should accept all options", () => {
    const config = new CyclesConfig({
      baseUrl: "http://localhost:7878",
      apiKey: "key",
      tenant: "acme",
      workspace: "prod",
      app: "chat",
      connectTimeout: 3_000,
      retryEnabled: false,
    });
    expect(config.tenant).toBe("acme");
    expect(config.workspace).toBe("prod");
    expect(config.app).toBe("chat");
    expect(config.connectTimeout).toBe(3_000);
    expect(config.retryEnabled).toBe(false);
  });

  describe("fromEnv", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should read from environment", () => {
      process.env.CYCLES_BASE_URL = "http://test:7878";
      process.env.CYCLES_API_KEY = "test-key";
      process.env.CYCLES_TENANT = "acme";

      const config = CyclesConfig.fromEnv();
      expect(config.baseUrl).toBe("http://test:7878");
      expect(config.apiKey).toBe("test-key");
      expect(config.tenant).toBe("acme");
    });

    it("should throw if BASE_URL missing", () => {
      process.env.CYCLES_API_KEY = "key";
      expect(() => CyclesConfig.fromEnv()).toThrow("CYCLES_BASE_URL");
    });

    it("should throw if API_KEY missing", () => {
      process.env.CYCLES_BASE_URL = "http://test:7878";
      expect(() => CyclesConfig.fromEnv()).toThrow("CYCLES_API_KEY");
    });

    it("should support custom prefix", () => {
      process.env.MY_BASE_URL = "http://custom:7878";
      process.env.MY_API_KEY = "custom-key";

      const config = CyclesConfig.fromEnv("MY_");
      expect(config.baseUrl).toBe("http://custom:7878");
      expect(config.apiKey).toBe("custom-key");
    });

    it("parses retry/timeout numeric env vars when set", () => {
      process.env.CYCLES_BASE_URL = "http://test:7878";
      process.env.CYCLES_API_KEY = "test-key";
      process.env.CYCLES_CONNECT_TIMEOUT = "1500";
      process.env.CYCLES_READ_TIMEOUT = "9000";
      process.env.CYCLES_RETRY_MAX_ATTEMPTS = "7";
      process.env.CYCLES_RETRY_INITIAL_DELAY = "250";
      process.env.CYCLES_RETRY_MULTIPLIER = "1.5";
      process.env.CYCLES_RETRY_MAX_DELAY = "10000";

      const config = CyclesConfig.fromEnv();
      expect(config.connectTimeout).toBe(1500);
      expect(config.readTimeout).toBe(9000);
      expect(config.retryMaxAttempts).toBe(7);
      expect(config.retryInitialDelay).toBe(250);
      expect(config.retryMultiplier).toBe(1.5);
      expect(config.retryMaxDelay).toBe(10000);
    });

    it("disables retry when CYCLES_RETRY_ENABLED=false", () => {
      process.env.CYCLES_BASE_URL = "http://test:7878";
      process.env.CYCLES_API_KEY = "test-key";
      process.env.CYCLES_RETRY_ENABLED = "false";

      const config = CyclesConfig.fromEnv();
      expect(config.retryEnabled).toBe(false);
    });
  });
});
