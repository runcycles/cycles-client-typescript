import { describe, it, expect, vi, afterEach } from "vitest";
import { CyclesClient } from "../src/client.js";
import { CyclesConfig } from "../src/config.js";
import { mockFetch, mockFetchError } from "./helpers.js";

const config = new CyclesConfig({
  baseUrl: "http://localhost:7878",
  apiKey: "test-key",
  tenant: "acme",
});

describe("CyclesClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("createReservation", () => {
    it("sends POST with correct path and headers", async () => {
      mockFetch(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: ["tenant:acme"],
      });

      const client = new CyclesClient(config);
      const resp = await client.createReservation({
        idempotency_key: "idem-1",
        subject: { tenant: "acme" },
        action: { kind: "llm.completion", name: "gpt-4" },
        estimate: { unit: "USD_MICROCENTS", amount: 1000 },
      });

      expect(resp.isSuccess).toBe(true);
      expect(resp.getBodyAttribute("decision")).toBe("ALLOW");
      // Body is stored in wire format (snake_case)
      expect(resp.getBodyAttribute("reservation_id")).toBe("r-1");

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe("http://localhost:7878/v1/reservations");
      const opts = fetchCall[1] as RequestInit;
      expect(opts.method).toBe("POST");
      const headers = opts.headers as Record<string, string>;
      expect(headers["X-Cycles-API-Key"]).toBe("test-key");
      expect(headers["X-Idempotency-Key"]).toBe("idem-1");
    });
  });

  describe("commitReservation", () => {
    it("sends POST to correct path", async () => {
      mockFetch(200, { status: "COMMITTED", charged: { unit: "USD_MICROCENTS", amount: 500 } });

      const client = new CyclesClient(config);
      const resp = await client.commitReservation("r-1", {
        idempotency_key: "commit-1",
        actual: { unit: "USD_MICROCENTS", amount: 500 },
      });

      expect(resp.isSuccess).toBe(true);
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe("http://localhost:7878/v1/reservations/r-1/commit");
    });
  });

  describe("releaseReservation", () => {
    it("sends POST to correct path", async () => {
      mockFetch(200, { status: "RELEASED", released: { unit: "USD_MICROCENTS", amount: 1000 } });

      const client = new CyclesClient(config);
      const resp = await client.releaseReservation("r-1", {
        idempotency_key: "release-1",
        reason: "cancelled",
      });

      expect(resp.isSuccess).toBe(true);
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe("http://localhost:7878/v1/reservations/r-1/release");
    });
  });

  describe("extendReservation", () => {
    it("sends POST to correct path", async () => {
      mockFetch(200, { status: "ACTIVE", expires_at_ms: 9999999 });

      const client = new CyclesClient(config);
      const resp = await client.extendReservation("r-1", {
        idempotency_key: "ext-1",
        extend_by_ms: 30000,
      });

      expect(resp.isSuccess).toBe(true);
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe("http://localhost:7878/v1/reservations/r-1/extend");
    });
  });

  describe("decide", () => {
    it("sends POST to /v1/decide", async () => {
      mockFetch(200, { decision: "ALLOW" });

      const client = new CyclesClient(config);
      const resp = await client.decide({
        idempotency_key: "dec-1",
        subject: { tenant: "acme" },
        action: { kind: "llm.completion", name: "gpt-4" },
        estimate: { unit: "USD_MICROCENTS", amount: 1000 },
      });

      expect(resp.isSuccess).toBe(true);
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe("http://localhost:7878/v1/decide");
    });
  });

  describe("listReservations", () => {
    it("sends GET with params", async () => {
      mockFetch(200, { reservations: [] });

      const client = new CyclesClient(config);
      const resp = await client.listReservations({ tenant: "acme" });

      expect(resp.isSuccess).toBe(true);
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toContain("tenant=acme");
    });
  });

  describe("getReservation", () => {
    it("sends GET to correct path", async () => {
      mockFetch(200, { reservation_id: "r-1", status: "ACTIVE" });

      const client = new CyclesClient(config);
      const resp = await client.getReservation("r-1");

      expect(resp.isSuccess).toBe(true);
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe("http://localhost:7878/v1/reservations/r-1");
    });
  });

  describe("getBalances", () => {
    it("sends GET with subject filter", async () => {
      mockFetch(200, { balances: [] });

      const client = new CyclesClient(config);
      const resp = await client.getBalances({ tenant: "acme" });

      expect(resp.isSuccess).toBe(true);
    });

    it("throws without subject filter", async () => {
      const client = new CyclesClient(config);
      await expect(client.getBalances({ cursor: "abc" })).rejects.toThrow("at least one subject filter");
    });
  });

  describe("createEvent", () => {
    it("sends POST to /v1/events", async () => {
      mockFetch(200, { status: "APPLIED", event_id: "e-1" });

      const client = new CyclesClient(config);
      const resp = await client.createEvent({
        idempotency_key: "evt-1",
        subject: { tenant: "acme" },
        action: { kind: "api.call", name: "geocode" },
        actual: { unit: "USD_MICROCENTS", amount: 1500 },
      });

      expect(resp.isSuccess).toBe(true);
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe("http://localhost:7878/v1/events");
    });
  });

  describe("error handling", () => {
    it("returns http error for 4xx", async () => {
      mockFetch(400, {
        error: "INVALID_REQUEST",
        message: "Missing field",
        request_id: "req-1",
      });

      const client = new CyclesClient(config);
      const resp = await client.createReservation({ idempotency_key: "test" });

      expect(resp.isSuccess).toBe(false);
      expect(resp.isClientError).toBe(true);
    });

    it("returns transport error on network failure", async () => {
      mockFetchError(new Error("ECONNREFUSED"));

      const client = new CyclesClient(config);
      const resp = await client.createReservation({ idempotency_key: "test" });

      expect(resp.isTransportError).toBe(true);
      expect(resp.errorMessage).toBe("ECONNREFUSED");
    });
  });

  describe("wire-format passthrough", () => {
    it("passes request body through as-is (caller provides wire-format)", async () => {
      mockFetch(200, { decision: "ALLOW", reservation_id: "r-1", affected_scopes: [] });

      const client = new CyclesClient(config);
      await client.createReservation({
        idempotency_key: "idem-1",
        subject: { tenant: "acme" },
        action: { kind: "llm", name: "gpt" },
        estimate: { unit: "USD_MICROCENTS", amount: 100 },
        ttl_ms: 30000,
        grace_period_ms: 5000,
      });

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const sentBody = JSON.parse(fetchCall[1]!.body as string);
      expect(sentBody.idempotency_key).toBe("idem-1");
      expect(sentBody.ttl_ms).toBe(30000);
      expect(sentBody.grace_period_ms).toBe(5000);
    });

    it("stores response body in wire format (snake_case)", async () => {
      mockFetch(200, {
        decision: "ALLOW",
        reservation_id: "r-1",
        affected_scopes: ["tenant:acme"],
        expires_at_ms: 9999999,
      });

      const client = new CyclesClient(config);
      const resp = await client.createReservation({ idempotency_key: "idem-1" });

      // Response body is in wire format — callers use mappers for typed access
      expect(resp.getBodyAttribute("reservation_id")).toBe("r-1");
      expect(resp.getBodyAttribute("affected_scopes")).toEqual(["tenant:acme"]);
      expect(resp.getBodyAttribute("expires_at_ms")).toBe(9999999);
    });
  });
});
