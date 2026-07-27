/** Global test setup: isolate the commit journal from the real home directory. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "vitest";

import { _setDefaultJournalDirOverride } from "../src/journal.js";
import { _resetReplayStateForTests } from "../src/retry.js";

let journalDir: string | undefined;

beforeEach(() => {
  // Without this, any engine built from a default CyclesConfig would write
  // journal files into the real ~/.runcycles during tests.
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "runcycles-journal-test-"));
  _setDefaultJournalDirOverride(journalDir);
  _resetReplayStateForTests();
});

afterEach(() => {
  if (journalDir !== undefined) {
    try {
      fs.rmSync(journalDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup — a locked file must not fail the test run
    }
    journalDir = undefined;
  }
});
