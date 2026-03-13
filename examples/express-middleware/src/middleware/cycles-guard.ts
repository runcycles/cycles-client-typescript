/**
 * Reusable Express middleware for Cycles budget governance.
 *
 * Reserves budget before the route handler runs and attaches the
 * reservation handle to res.locals.cyclesHandle. Automatically
 * releases the reservation if the client disconnects mid-stream.
 */

import type { Request, Response, NextFunction } from "express";
import {
  CyclesClient,
  reserveForStream,
  BudgetExceededError,
  type StreamReservation,
} from "runcycles";

export interface CyclesGuardOptions {
  client: CyclesClient;
  /** Compute the estimated cost in microcents from the request. */
  estimateFn: (req: Request) => number;
  actionKind?: string;
  actionName?: string;
  unit?: string;
}

/** Extend res.locals with the Cycles handle for downstream routes. */
declare module "express" {
  interface Locals {
    cyclesHandle?: StreamReservation;
  }
}

/**
 * Factory that returns Express middleware for budget governance.
 *
 * Usage:
 *   app.post("/api/chat", cyclesGuard({ client, estimateFn, actionKind }), chatRoute);
 */
export function cyclesGuard(options: CyclesGuardOptions) {
  const {
    client,
    estimateFn,
    actionKind = "llm.completion",
    actionName = "unknown",
    unit = "USD_MICROCENTS",
  } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    const estimate = estimateFn(req);

    let handle: StreamReservation;
    try {
      handle = await reserveForStream({
        client,
        estimate,
        unit,
        actionKind,
        actionName,
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        res.status(402).json({
          error: "budget_exceeded",
          message: "Your budget has been exhausted. Please contact your administrator.",
        });
        return;
      }
      next(err);
      return;
    }

    // Attach the handle for the route handler to use.
    res.locals.cyclesHandle = handle;

    // If the client disconnects before the route commits,
    // release the reservation to return unused budget.
    req.on("close", () => {
      if (!handle.finalized) {
        void handle.release("client_disconnect");
      }
    });

    next();
  };
}
