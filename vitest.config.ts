import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  // Normalize root to fix Windows drive-letter casing issues
  // (see https://github.com/vitest-dev/vitest/issues/5251)
  root: resolve("."),
  test: {
    // Use threads pool — the default 'forks' pool has issues on
    // Node 24 + Windows (https://github.com/vitest-dev/vitest/issues/8861)
    pool: "threads",
  },
});
