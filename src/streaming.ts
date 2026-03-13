/**
 * First-class streaming adapter for Cycles budget governance.
 *
 * Unlike `withCycles` (which wraps a Promise-returning function and commits
 * immediately after the function resolves), `reserveForStream` returns a
 * handle that lets the caller control when to commit or release. This is
 * essential for LLM streaming where the function returns a stream object
 * immediately but actual usage is only known after the stream finishes.
 *
 * Typical lifecycle:
 *   1. `reserveForStream(...)` — creates reservation + starts heartbeat
 *   2. Start streaming (e.g. `streamText(...)`)
 *   3. On stream finish → `handle.commit(actualCost, metrics)`
 *   4. On stream error/abort → `handle.release("aborted")`
 *   5. Always → `handle.dispose()` to stop the heartbeat
 */

import { randomUUID } from "node:crypto";
import type { CyclesClient } from "./client.js";
import { buildProtocolException } from "./errors.js";
import { CyclesProtocolError } from "./exceptions.js";
import {
  metricsToWire,
  reservationCreateResponseFromWire,
} from "./mappers.js";
import type { Caps, CyclesMetrics, Decision, Subject } from "./models.js";
import { isMetricsEmpty } from "./models.js";
import {
  validateGracePeriodMs,
  validateNonNegative,
  validateSubject,
  validateTtlMs,
} from "./validation.js";

export interface StreamReservationOptions {
  client: CyclesClient;
  estimate: number;
  unit?: string;
  actionKind?: string;
  actionName?: string;
  actionTags?: string[];
  ttlMs?: number;
  gracePeriodMs?: number;
  overagePolicy?: string;
  tenant?: string;
  workspace?: string;
  app?: string;
  workflow?: string;
  agent?: string;
  toolset?: string;
  dimensions?: Record<string, string>;
}

export interface StreamReservation {
  /** The reservation ID from the server. */
  readonly reservationId: string;
  /** The budget decision (ALLOW or ALLOW_WITH_CAPS). */
  readonly decision: Decision;
  /** Caps imposed by the budget, if any. */
  readonly caps: Caps | undefined;

  /**
   * Commit actual usage after the stream completes successfully.
   * Call this from `onFinish` or equivalent.
   */
  commit(
    actual: number,
    metrics?: CyclesMetrics,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Release the reservation on error or abort.
   * Best-effort — errors are swallowed.
   */
  release(reason?: string): Promise<void>;

  /**
   * Stop the heartbeat timer. Always call this in a `finally` block.
   * Safe to call multiple times.
   */
  dispose(): void;
}

/**
 * Reserve budget for a streaming operation and return a handle to
 * commit or release when the stream completes.
 *
 * Throws `BudgetExceededError` (or other protocol errors) if the
 * reservation is denied.
 */
export async function reserveForStream(
  options: StreamReservationOptions,
): Promise<StreamReservation> {
  const {
    client,
    estimate,
    unit = "USD_MICROCENTS",
    actionKind = "unknown",
    actionName = "unknown",
    actionTags,
    ttlMs = 60_000,
    gracePeriodMs,
    overagePolicy = "REJECT",
    dimensions,
  } = options;

  validateNonNegative(estimate, "estimate");
  validateTtlMs(ttlMs);
  validateGracePeriodMs(gracePeriodMs);

  // Build subject from options, falling back to client config defaults
  const configDefaults = client.config;
  const subject: Record<string, unknown> = {};
  for (const field of ["tenant", "workspace", "app", "workflow", "agent", "toolset"] as const) {
    const val = options[field] ?? configDefaults[field];
    if (val) {
      subject[field] = val;
    }
  }
  if (dimensions) {
    subject.dimensions = dimensions;
  }
  validateSubject(subject as Subject);

  // Build action
  const action: Record<string, unknown> = { kind: actionKind, name: actionName };
  if (actionTags) {
    action.tags = actionTags;
  }

  // Build wire-format request body
  const body: Record<string, unknown> = {
    idempotency_key: randomUUID(),
    subject,
    action,
    estimate: { unit, amount: estimate },
    ttl_ms: ttlMs,
    overage_policy: overagePolicy,
  };
  if (gracePeriodMs !== undefined) {
    body.grace_period_ms = gracePeriodMs;
  }

  // Create reservation
  const response = await client.createReservation(body);
  if (!response.isSuccess) {
    throw buildProtocolException("Failed to create reservation", response);
  }

  const parsed = reservationCreateResponseFromWire(
    response.body as Record<string, unknown>,
  );

  if (parsed.decision === "DENY") {
    throw buildProtocolException("Reservation denied", response);
  }

  const reservationId = parsed.reservationId;
  if (!reservationId) {
    throw new CyclesProtocolError(
      "Reservation successful but reservation_id missing",
      { status: response.status },
    );
  }

  // Start heartbeat
  let disposed = false;
  let currentTimer: ReturnType<typeof setTimeout>;

  const startHeartbeat = (): void => {
    if (ttlMs <= 0) return;
    const intervalMs = Math.max(ttlMs / 2, 1_000);

    const tick = (): void => {
      if (disposed) return;
      currentTimer = setTimeout(() => {
        if (disposed) return;
        const extendBody = { idempotency_key: randomUUID(), extend_by_ms: ttlMs };
        void client
          .extendReservation(reservationId, extendBody)
          .catch(() => { /* best-effort */ })
          .finally(() => { tick(); });
      }, intervalMs);
    };

    tick();
  };

  startHeartbeat();

  return {
    reservationId,
    decision: parsed.decision as Decision,
    caps: parsed.caps,

    async commit(
      actual: number,
      metrics?: CyclesMetrics,
      metadata?: Record<string, unknown>,
    ): Promise<void> {
      const commitBody: Record<string, unknown> = {
        idempotency_key: randomUUID(),
        actual: { unit, amount: actual },
      };
      if (metrics && !isMetricsEmpty(metrics)) {
        commitBody.metrics = metricsToWire(metrics);
      }
      if (metadata) {
        commitBody.metadata = metadata;
      }
      await client.commitReservation(reservationId, commitBody);
    },

    async release(reason?: string): Promise<void> {
      try {
        const releaseBody = { idempotency_key: randomUUID(), reason: reason ?? "stream_aborted" };
        await client.releaseReservation(reservationId, releaseBody);
      } catch {
        // Best-effort release
      }
    },

    dispose(): void {
      if (!disposed) {
        disposed = true;
        clearTimeout(currentTimer);
      }
    },
  };
}
