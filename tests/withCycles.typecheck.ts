/**
 * Compile-time type tests for withCycles.
 *
 * This file is NOT executed — it is only type-checked by `tsc --noEmit`.
 * Lines marked @ts-expect-error MUST fail to compile; if they don't,
 * the type-check itself fails, catching type regressions in CI.
 */

import { withCycles } from "../src/withCycles.js";
import type { CyclesClient } from "../src/client.js";

declare const client: CyclesClient;

// ── Valid: typed estimate callback matching the wrapped function's args ──

withCycles(
  { estimate: (prompt: string) => prompt.length * 5, client },
  async (prompt: string) => prompt,
);

withCycles(
  { estimate: (text: string, maxTokens: number) => maxTokens * 10, client },
  async (text: string, maxTokens: number) => text,
);

// ── Valid: static number estimate ──

withCycles(
  { estimate: 1000, client },
  async (prompt: string) => prompt,
);

// ── Valid: typed actual callback matching the return type ──

withCycles(
  { estimate: 1000, actual: (result: string) => result.length * 5, client },
  async (prompt: string) => `Response to: ${prompt}`,
);

// ── Valid: estimate and actual both as callbacks ──

withCycles(
  {
    estimate: (prompt: string) => prompt.length * 10,
    actual: (result: string) => result.length * 5,
    client,
  },
  async (prompt: string) => `Response to: ${prompt}`,
);

// ── Invalid: estimate callback arg type doesn't match wrapped function ──

withCycles(
  { estimate: (x: number) => x * 5, client },
  // @ts-expect-error — fn takes string but estimate infers TArgs as [number]
  async (prompt: string) => prompt,
);

// ── Invalid: actual callback arg type doesn't match return type ──

withCycles(
  { estimate: 1000, actual: (result: number) => result * 5, client },
  // @ts-expect-error — fn returns string but actual infers TResult as number
  async (prompt: string) => `Response to: ${prompt}`,
);
