import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildManifest } from "../../src/manifest/build.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { systemClock } from "../../src/clock/clock.js";
import type { RunState, TargetState } from "../../src/dispatcher/state.js";

function target(overrides: Partial<TargetState>): TargetState {
  return {
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
    ...overrides,
  };
}

test("manifest aggregates stage1_seconds and stage2_seconds from per-target timestamps", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "atmf-"));
  // Empty targets/ subtree is fine — we are testing wall-clock derivation only.
  fs.mkdirSync(path.join(runDir, "targets"), { recursive: true });

  const state: RunState = {
    schema_version: 1,
    run_id: "20260509T120000Z-7711aabb",
    config_snapshot: { ...DEFAULT_CONFIG },
    started_at: "2026-05-09T12:00:00.000Z",
    ended_at: "2026-05-09T12:01:00.000Z",
    targets: {
      // Tier-1 happy path: stage1 = 1s, stage2 = 4s.
      "happy.js": target({
        state: "done",
        fingerprint: null,
        stage1_started_at: "2026-05-09T12:00:00.000Z",
        stage2_started_at: "2026-05-09T12:00:01.000Z",
        completed_at: "2026-05-09T12:00:05.000Z",
      }),
      // Stage-1 failure: stage1 = 2s, stage2 = 0.
      "fail.js": target({
        state: "failed",
        fingerprint: null,
        stage1_started_at: "2026-05-09T12:00:10.000Z",
        completed_at: "2026-05-09T12:00:12.000Z",
      }),
      // No-finding: stage1 = 3s, stage2 = 0.
      "clean.js": target({
        state: "no_finding",
        fingerprint: null,
        stage1_started_at: "2026-05-09T12:00:20.000Z",
        completed_at: "2026-05-09T12:00:23.000Z",
      }),
    },
    terminations: [],
  };

  const m = buildManifest({ runDir, state, clock: systemClock });
  assert.equal(m.wall_clock_totals.stage1_seconds, 6, "1+2+3 = 6 stage-1 seconds");
  assert.equal(m.wall_clock_totals.stage2_seconds, 4, "4 stage-2 seconds (only the happy path)");
  assert.equal(m.wall_clock_totals.run_seconds, 60, "started→ended = 60s");
});

test("manifest tolerates missing per-target timestamps", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "atmf2-"));
  fs.mkdirSync(path.join(runDir, "targets"), { recursive: true });

  const state: RunState = {
    schema_version: 1,
    run_id: "20260509T120000Z-12345678",
    config_snapshot: { ...DEFAULT_CONFIG },
    started_at: "2026-05-09T12:00:00.000Z",
    ended_at: "2026-05-09T12:00:00.000Z",
    targets: {
      "queued.js": target({ state: "queued" }),
    },
    terminations: [],
  };
  const m = buildManifest({ runDir, state, clock: systemClock });
  assert.equal(m.wall_clock_totals.stage1_seconds, 0);
  assert.equal(m.wall_clock_totals.stage2_seconds, 0);
});
