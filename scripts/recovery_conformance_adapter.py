#!/usr/bin/env python3
"""Bind shared recovery scenario IDs to native TypeScript SDK behavior tests."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

TESTS = {
    "CR-CORE-001": [("tests/retry.test.ts", "retries on failure then succeeds")],
    "CR-CORE-002": [("tests/journal.test.ts", "recovers spend via scheduleEvent on an expired first commit")],
    "CR-CORE-003": [("tests/lifecycle.test.ts", "heartbeat logs thrown transport failures and keeps the action alive")],
    "CR-CORE-004": [("tests/journal.test.ts", "treats a protocol-invalid 2xx as ambiguous and preserves the key")],
    "CR-DURABLE-001": [
        ("tests/journal.test.ts", "journals before the first commit request and discards valid success"),
        ("tests/journal.test.ts", "replays pending commits when the first engine appears"),
        ("tests/retry.test.ts", "retries on failure then succeeds"),
    ],
    "CR-DURABLE-002": [
        ("tests/journal.test.ts", "falls back to POST /v1/events when the reservation expired"),
        ("tests/journal.test.ts", "replays event-mode entries via createEvent"),
    ],
    "CR-DURABLE-003": [
        ("tests/journal.test.ts", "treats 429 as transient, honors Retry-After, and persists the floor"),
        ("tests/journal.test.ts", "restores a future Retry-After floor and ignores a past one"),
    ],
    "CR-DURABLE-004": [("tests/journal.test.ts", "survives API-key rotation when a tenant is configured")],
    "CR-DURABLE-005": [(
        "tests/journal.test.ts",
        "quarantines corrupt and unsupported records without blocking valid replay",
    )],
    "CR-DURABLE-006": [("tests/journal.test.ts", "concurrent replay workers reuse one key and remove the record")],
    "CR-DURABLE-007": [("tests/journal.test.ts", "uses cross-SDK digest names and safely migrates colliding legacy names")],
    "CR-BOUNDARY-001": [("tests/lifecycle.test.ts", "throws when actual is undefined and useEstimateIfActualNotProvided is false")],
}


def main() -> int:
    if len(sys.argv) != 2:
        print("expected one scenario ID", file=sys.stderr)
        return 2
    scenario = json.load(sys.stdin)
    scenario_id = sys.argv[1]
    if scenario.get("id") != scenario_id or scenario_id not in TESTS:
        print("unknown or mismatched scenario ID", file=sys.stderr)
        return 2
    if "expected_requests" in scenario or "assertions" in scenario:
        print("runner disclosed conformance oracle", file=sys.stderr)
        return 2
    npx = "npx.cmd" if os.name == "nt" else "npx"
    executed = []
    passed = True
    last_code = 0
    for test_file, pattern in TESTS[scenario_id]:
        completed = subprocess.run(
            [npx, "vitest", "run", test_file, "-t", pattern],
            cwd=ROOT, text=True, capture_output=True, check=False,
        )
        executed.append(f"{test_file} > {pattern}")
        last_code = completed.returncode
        if completed.stdout:
            print(completed.stdout, file=sys.stderr, end="")
        if completed.stderr:
            print(completed.stderr, file=sys.stderr, end="")
        if completed.returncode != 0:
            passed = False
            break
    json.dump({
        "scenario_id": scenario_id,
        "passed": passed,
        "native_tests": executed,
        "diagnostic": f"native vitest exit code {last_code}",
    }, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
