/**
 * Async HTTP client for the Cycles API.
 *
 * The client is transport-oriented and runtime-agnostic: it sends and receives
 * wire-format (snake_case) JSON bodies without any automatic key conversion.
 * Callers are responsible for building wire-format request bodies; the response
 * body is returned in wire format for explicit mapping by the caller.
 *
 * Timeout note: Node's built-in fetch does not distinguish connection timeout
 * from read timeout. The config's connectTimeout and readTimeout are summed
 * into a single AbortSignal.timeout() value that caps total request duration.
 * For stricter timeout control, consider using a custom HTTP client.
 */

import {
  API_KEY_HEADER,
  BALANCES_PATH,
  DECIDE_PATH,
  EVENTS_PATH,
  IDEMPOTENCY_KEY_HEADER,
  RESERVATIONS_PATH,
} from "./constants.js";
import type { CyclesConfig } from "./config.js";
import { CyclesResponse } from "./response.js";

const RESPONSE_HEADERS = [
  "x-request-id",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-cycles-tenant",
] as const;

const BALANCE_FILTER_PARAMS = new Set([
  "tenant",
  "workspace",
  "app",
  "workflow",
  "agent",
  "toolset",
]);

function extractResponseHeaders(resp: Response): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of RESPONSE_HEADERS) {
    const val = resp.headers.get(name);
    if (val !== null) {
      result[name] = val;
    }
  }
  return result;
}

export class CyclesClient {
  private readonly _config: CyclesConfig;

  constructor(config: CyclesConfig) {
    this._config = config;
  }

  get config(): CyclesConfig {
    return this._config;
  }

  async createReservation(
    request: Record<string, unknown>,
  ): Promise<CyclesResponse> {
    return this._post(RESERVATIONS_PATH, request);
  }

  async commitReservation(
    reservationId: string,
    request: Record<string, unknown>,
  ): Promise<CyclesResponse> {
    return this._post(
      `${RESERVATIONS_PATH}/${reservationId}/commit`,
      request,
    );
  }

  async releaseReservation(
    reservationId: string,
    request: Record<string, unknown>,
  ): Promise<CyclesResponse> {
    return this._post(
      `${RESERVATIONS_PATH}/${reservationId}/release`,
      request,
    );
  }

  async extendReservation(
    reservationId: string,
    request: Record<string, unknown>,
  ): Promise<CyclesResponse> {
    return this._post(
      `${RESERVATIONS_PATH}/${reservationId}/extend`,
      request,
    );
  }

  async decide(request: Record<string, unknown>): Promise<CyclesResponse> {
    return this._post(DECIDE_PATH, request);
  }

  async listReservations(
    params?: Record<string, string>,
  ): Promise<CyclesResponse> {
    return this._get(RESERVATIONS_PATH, params);
  }

  async getReservation(reservationId: string): Promise<CyclesResponse> {
    return this._get(`${RESERVATIONS_PATH}/${reservationId}`);
  }

  async getBalances(params: Record<string, string>): Promise<CyclesResponse> {
    const hasFilter = Object.keys(params).some((k) =>
      BALANCE_FILTER_PARAMS.has(k),
    );
    if (!hasFilter) {
      throw new Error(
        "getBalances requires at least one subject filter (tenant, workspace, app, workflow, agent, or toolset)",
      );
    }
    return this._get(BALANCES_PATH, params);
  }

  async createEvent(
    request: Record<string, unknown>,
  ): Promise<CyclesResponse> {
    return this._post(EVENTS_PATH, request);
  }

  private async _post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<CyclesResponse> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        [API_KEY_HEADER]: this._config.apiKey,
      };

      // Extract idempotency key from wire-format body
      const idemKey = body.idempotency_key;
      if (typeof idemKey === "string") {
        headers[IDEMPOTENCY_KEY_HEADER] = idemKey;
      }

      const url = `${this._config.baseUrl}${path}`;
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(
          this._config.connectTimeout + this._config.readTimeout,
        ),
      });

      return this._handleResponse(resp);
    } catch (err) {
      return CyclesResponse.transportError(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private async _get(
    path: string,
    params?: Record<string, string>,
  ): Promise<CyclesResponse> {
    try {
      let url = `${this._config.baseUrl}${path}`;
      if (params && Object.keys(params).length > 0) {
        const qs = new URLSearchParams(params).toString();
        url = `${url}?${qs}`;
      }

      const resp = await fetch(url, {
        method: "GET",
        headers: {
          [API_KEY_HEADER]: this._config.apiKey,
        },
        signal: AbortSignal.timeout(
          this._config.connectTimeout + this._config.readTimeout,
        ),
      });

      return this._handleResponse(resp);
    } catch (err) {
      return CyclesResponse.transportError(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private async _handleResponse(resp: Response): Promise<CyclesResponse> {
    // Response body is stored in wire format (snake_case).
    // Callers use explicit mappers from mappers.ts for type-safe access.
    let body: Record<string, unknown> | undefined;
    try {
      body = (await resp.json()) as Record<string, unknown>;
    } catch {
      body = undefined;
    }

    const headers = extractResponseHeaders(resp);

    if (resp.status >= 200 && resp.status < 300) {
      return CyclesResponse.success(resp.status, body ?? {}, headers);
    }

    let errorMsg: string | undefined;
    if (body && typeof body === "object") {
      errorMsg =
        (body.message as string) ?? (body.error as string) ?? undefined;
    }
    return CyclesResponse.httpError(
      resp.status,
      errorMsg ?? resp.statusText ?? "Unknown error",
      body,
      headers,
    );
  }
}
