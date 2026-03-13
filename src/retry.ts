/** Background commit retry engine with exponential backoff. */

import type { CyclesConfig } from "./config.js";
import type { CyclesClient } from "./client.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CommitRetryEngine {
  private readonly _enabled: boolean;
  private readonly _maxAttempts: number;
  private readonly _initialDelay: number;
  private readonly _multiplier: number;
  private readonly _maxDelay: number;
  private _client: CyclesClient | undefined;

  constructor(config: CyclesConfig) {
    this._enabled = config.retryEnabled;
    this._maxAttempts = config.retryMaxAttempts;
    this._initialDelay = config.retryInitialDelay;
    this._multiplier = config.retryMultiplier;
    this._maxDelay = config.retryMaxDelay;
  }

  setClient(client: CyclesClient): void {
    this._client = client;
  }

  schedule(
    reservationId: string,
    commitBody: Record<string, unknown>,
  ): void {
    if (!this._enabled) {
      return;
    }

    // Fire-and-forget async retry loop
    void this._retryLoop(reservationId, commitBody);
  }

  private async _retryLoop(
    reservationId: string,
    commitBody: Record<string, unknown>,
  ): Promise<void> {
    for (let attempt = 0; attempt < this._maxAttempts; attempt++) {
      const backoff = Math.min(
        this._initialDelay * this._multiplier ** attempt,
        this._maxDelay,
      );
      await delay(backoff);

      try {
        if (!this._client) {
          return;
        }

        const response = await this._client.commitReservation(
          reservationId,
          commitBody,
        );

        if (response.isSuccess) {
          return;
        }

        if (response.isClientError) {
          // Non-retryable error
          return;
        }
      } catch {
        // Continue retrying on transport errors
      }
    }

    console.warn(
      `[runcycles] Commit retry exhausted after ${this._maxAttempts} attempts for reservation ${reservationId}`,
    );
  }
}
