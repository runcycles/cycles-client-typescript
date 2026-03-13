/** Uniform response wrapper for all Cycles API calls. */

import type { ErrorResponse } from "./models.js";

export class CyclesResponse {
  readonly status: number;
  readonly body: Record<string, unknown> | undefined;
  readonly errorMessage: string | undefined;
  readonly headers: Record<string, string>;
  private readonly _isTransportError: boolean;
  readonly transportError: Error | undefined;

  private constructor(options: {
    status: number;
    body?: Record<string, unknown>;
    errorMessage?: string;
    headers?: Record<string, string>;
    isTransportError?: boolean;
    transportError?: Error;
  }) {
    this.status = options.status;
    this.body = options.body;
    this.errorMessage = options.errorMessage;
    this.headers = options.headers ?? {};
    this._isTransportError = options.isTransportError ?? false;
    this.transportError = options.transportError;
  }

  static success(
    status: number,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
  ): CyclesResponse {
    return new CyclesResponse({ status, body, headers });
  }

  static httpError(
    status: number,
    errorMessage: string,
    body?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): CyclesResponse {
    return new CyclesResponse({ status, body, errorMessage, headers });
  }

  static transportError(err: Error): CyclesResponse {
    return new CyclesResponse({
      status: -1,
      errorMessage: err.message,
      isTransportError: true,
      transportError: err,
    });
  }

  get requestId(): string | undefined {
    return this.headers["x-request-id"];
  }

  get rateLimitRemaining(): number | undefined {
    const val = this.headers["x-ratelimit-remaining"];
    return val !== undefined ? parseInt(val, 10) : undefined;
  }

  get rateLimitReset(): number | undefined {
    const val = this.headers["x-ratelimit-reset"];
    return val !== undefined ? parseInt(val, 10) : undefined;
  }

  get cyclesTenant(): string | undefined {
    return this.headers["x-cycles-tenant"];
  }

  get isSuccess(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  get isServerError(): boolean {
    return this.status >= 500 && this.status < 600;
  }

  get isTransportError(): boolean {
    return this._isTransportError;
  }

  getBodyAttribute(key: string): unknown {
    if (this.body && key in this.body) {
      return this.body[key];
    }
    return undefined;
  }

  getErrorResponse(): ErrorResponse | undefined {
    if (this.body && typeof this.body === "object") {
      const b = this.body as Record<string, unknown>;
      if (typeof b.error === "string" && typeof b.message === "string" && typeof b.requestId === "string") {
        return {
          error: b.error,
          message: b.message,
          requestId: b.requestId,
          details: b.details as Record<string, unknown> | undefined,
        };
      }
    }
    return undefined;
  }
}
