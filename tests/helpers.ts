/** Shared test helpers. */

import { vi } from "vitest";

export function mockFetch(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): void {
  const responseHeaders = new Headers(headers ?? {});
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      statusText: status >= 400 ? "Error" : "OK",
      json: () => Promise.resolve(body),
      headers: responseHeaders,
    }),
  );
}

export function mockFetchError(error: Error): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
}

export function mockFetchSequence(
  responses: Array<{
    status: number;
    body: Record<string, unknown>;
    headers?: Record<string, string>;
  }>,
): void {
  let callIndex = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() => {
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      const responseHeaders = new Headers(resp.headers ?? {});
      return Promise.resolve({
        status: resp.status,
        statusText: resp.status >= 400 ? "Error" : "OK",
        json: () => Promise.resolve(resp.body),
        headers: responseHeaders,
      });
    }),
  );
}
