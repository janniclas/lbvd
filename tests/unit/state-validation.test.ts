import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadState, saveState, initState, StateValidationError } from "../../src/dispatcher/state.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

function tmpRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atstate-"));
}

test("loadState rejects fingerprint with path traversal", () => {
  const runDir = tmpRunDir();
  const state = initState({
    runId: "20260509T120000Z-deadbeef",
    config: DEFAULT_CONFIG,
    startedAt: new Date().toISOString(),
    targets: {
      "src/x.js": {
        state: "stage2_running",
        fingerprint: "../../../etc",
        branch_url: null,
        issue_url: null,
        infra_issue_url: null,
        tracking_issue_url: null,
        error: null,
        stage1_started_at: null,
        stage2_started_at: null,
        completed_at: null,
      },
    },
  });
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(state));
  assert.throws(
    () => loadState(runDir),
    (e: unknown) => e instanceof StateValidationError,
  );
});

test("loadState rejects unknown target state", () => {
  const runDir = tmpRunDir();
  const raw = {
    schema_version: 1,
    run_id: "20260509T120000Z-deadbeef",
    config_snapshot: DEFAULT_CONFIG,
    started_at: new Date().toISOString(),
    ended_at: null,
    targets: {
      "x.js": {
        state: "totally_made_up",
        fingerprint: null,
        branch_url: null,
        issue_url: null,
        infra_issue_url: null,
        tracking_issue_url: null,
        error: null,
        stage1_started_at: null,
        stage2_started_at: null,
        completed_at: null,
      },
    },
    terminations: [],
  };
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(raw));
  assert.throws(
    () => loadState(runDir),
    (e: unknown) => e instanceof StateValidationError,
  );
});

test("loadState round-trips a valid state", () => {
  const runDir = tmpRunDir();
  const state = initState({
    runId: "20260509T120000Z-deadbeef",
    config: DEFAULT_CONFIG,
    startedAt: new Date().toISOString(),
    targets: {
      "x.js": {
        state: "queued",
        fingerprint: null,
        branch_url: null,
        issue_url: null,
        infra_issue_url: null,
        tracking_issue_url: null,
        error: null,
        stage1_started_at: null,
        stage2_started_at: null,
        completed_at: null,
      },
    },
  });
  saveState(runDir, state);
  const round = loadState(runDir);
  assert.equal(round.run_id, state.run_id);
  assert.equal(round.targets["x.js"]?.state, "queued");
});
