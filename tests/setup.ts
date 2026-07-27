/** Global test setup: isolate the commit journal from the real home directory. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach } from "vitest";

import { _setDefaultJournalDirOverride } from "../src/journal.js";
import { _resetReplayStateForTests } from "../src/retry.js";

beforeEach(() => {
  // Without this, any engine built from a default CyclesConfig would write
  // journal files into the real ~/.runcycles during tests.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runcycles-journal-test-"));
  _setDefaultJournalDirOverride(dir);
  _resetReplayStateForTests();
});
