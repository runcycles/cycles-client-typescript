/** AsyncLocalStorage-based context holder for active Cycles reservations. */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Amount, Balance, Caps, CyclesMetrics, Decision } from "./models.js";

export interface CyclesContext {
  readonly reservationId: string;
  readonly estimate: number;
  readonly decision: Decision;
  readonly caps?: Caps;
  expiresAtMs?: number;
  readonly affectedScopes?: string[];
  readonly scopePath?: string;
  readonly reserved?: Amount;
  readonly balances?: Balance[];
  metrics?: CyclesMetrics;
  commitMetadata?: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<CyclesContext>();

export function getCyclesContext(): CyclesContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(ctx: CyclesContext, fn: () => T): T {
  return storage.run(ctx, fn);
}
