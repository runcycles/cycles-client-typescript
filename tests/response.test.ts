import { describe, it, expect } from "vitest";
import { CyclesResponse } from "../src/response.js";

describe("CyclesResponse", () => {
  describe("success", () => {
    it("creates success response", () => {
      const resp = CyclesResponse.success(200, { reservationId: "r-1" }, { "x-request-id": "req-1" });
      expect(resp.isSuccess).toBe(true);
      expect(resp.isClientError).toBe(false);
      expect(resp.isServerError).toBe(false);
      expect(resp.isTransportError).toBe(false);
      expect(resp.status).toBe(200);
      expect(resp.getBodyAttribute("reservationId")).toBe("r-1");
      expect(resp.requestId).toBe("req-1");
    });
  });

  describe("httpError", () => {
    it("creates client error", () => {
      const resp = CyclesResponse.httpError(400, "Bad request");
      expect(resp.isSuccess).toBe(false);
      expect(resp.isClientError).toBe(true);
      expect(resp.errorMessage).toBe("Bad request");
    });

    it("creates server error", () => {
      const resp = CyclesResponse.httpError(500, "Internal error");
      expect(resp.isServerError).toBe(true);
    });
  });

  describe("transportError", () => {
    it("creates transport error", () => {
      const err = new Error("Connection refused");
      const resp = CyclesResponse.transportError(err);
      expect(resp.isTransportError).toBe(true);
      expect(resp.status).toBe(-1);
      expect(resp.errorMessage).toBe("Connection refused");
      expect(resp.transportError).toBe(err);
    });
  });

  describe("header properties", () => {
    it("parses rate limit headers", () => {
      const resp = CyclesResponse.success(200, {}, {
        "x-ratelimit-remaining": "42",
        "x-ratelimit-reset": "1700000000",
        "x-cycles-tenant": "acme",
      });
      expect(resp.rateLimitRemaining).toBe(42);
      expect(resp.rateLimitReset).toBe(1700000000);
      expect(resp.cyclesTenant).toBe("acme");
    });

    it("returns undefined for missing headers", () => {
      const resp = CyclesResponse.success(200, {});
      expect(resp.requestId).toBeUndefined();
      expect(resp.rateLimitRemaining).toBeUndefined();
    });
  });

  describe("getBodyAttribute", () => {
    it("returns attribute value", () => {
      const resp = CyclesResponse.success(200, { foo: "bar" });
      expect(resp.getBodyAttribute("foo")).toBe("bar");
    });

    it("returns undefined for missing key", () => {
      const resp = CyclesResponse.success(200, { foo: "bar" });
      expect(resp.getBodyAttribute("baz")).toBeUndefined();
    });

    it("returns undefined for undefined body", () => {
      const resp = CyclesResponse.transportError(new Error("fail"));
      expect(resp.getBodyAttribute("foo")).toBeUndefined();
    });
  });

  describe("getErrorResponse", () => {
    it("parses error response from wire-format body", () => {
      const resp = CyclesResponse.httpError(400, "Bad", {
        error: "INVALID_REQUEST",
        message: "Missing field",
        request_id: "req-1",
        details: { field: "name" },
      });
      const errResp = resp.getErrorResponse();
      expect(errResp).toBeDefined();
      expect(errResp!.error).toBe("INVALID_REQUEST");
      expect(errResp!.message).toBe("Missing field");
      expect(errResp!.requestId).toBe("req-1");
    });

    it("returns undefined for non-error body", () => {
      const resp = CyclesResponse.success(200, { foo: "bar" });
      expect(resp.getErrorResponse()).toBeUndefined();
    });
  });
});
