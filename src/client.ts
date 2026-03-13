/** Async HTTP client for the Cycles API. */

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

// --- Case conversion utilities ---

function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function convertKeysToSnakeCase(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(convertKeysToSnakeCase);
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (value !== undefined) {
        result[toSnakeCase(key)] = convertKeysToSnakeCase(value);
      }
    }
    return result;
  }
  return obj;
}

function convertKeysToCamelCase(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(convertKeysToCamelCase);
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[toCamelCase(key)] = convertKeysToCamelCase(value);
    }
    return result;
  }
  return obj;
}

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
      const data = convertKeysToSnakeCase(body) as Record<string, unknown>;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        [API_KEY_HEADER]: this._config.apiKey,
      };

      const idemKey = data.idempotency_key;
      if (typeof idemKey === "string") {
        headers[IDEMPOTENCY_KEY_HEADER] = idemKey;
      }

      const url = `${this._config.baseUrl}${path}`;
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(data),
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
    let body: Record<string, unknown> | undefined;
    try {
      const raw = await resp.json();
      body = convertKeysToCamelCase(raw) as Record<string, unknown>;
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
