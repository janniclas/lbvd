import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { invokeStage1 } from "../../src/stage1/invoke.js";
import { invokeStage2 } from "../../src/stage2/invoke.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { systemClock } from "../../src/clock/clock.js";
import { nullLogger } from "../../src/log/log.js";
import type { Runner, RunnerExit, SpawnedRunner, RunnerInput } from "../../src/runner/interface.js";
import type { Finding } from "../../src/stage1/schema.js";

// Fake runner whose `spawn().done` resolves cleanly *after* the budget
// timer is observed to fire. The agent's expected output is pre-staged on
// disk before the call so the post-race success branch sees it.
function fakeSlowRunner(opts: {
  prestage: (input: RunnerInput) => void;
  delayMs: number;
}): Runner {
  return {
    kind: "fixture",
    async spawn(input: RunnerInput): Promise<SpawnedRunner> {
      opts.prestage(input);
      const pid = 4242;
      const done = new Promise<RunnerExit>((resolve) => {
        setTimeout(() => resolve({ code: 0, signal: null, wallSeconds: opts.delayMs / 1000 }), opts.delayMs);
      });
      return { pid, done };
    },
    async spawnProbe(): Promise<SpawnedRunner> {
      return { pid: 4243, done: Promise.resolve({ code: 0, signal: null, wallSeconds: 0 }) };
    },
    async abort(): Promise<void> {
      // Simulate the SDK runner: the abort lands AFTER the child has already
      // exited, so the kill is a no-op. We do nothing here.
    },
  };
}

test("stage1: budget timer fires but child exits cleanly with valid finding → success", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "atrace-"));
  const pendingSubtree = path.join(runDir, "targets", "_pending", "abc");
  fs.mkdirSync(pendingSubtree, { recursive: true });
  const finding = {
    schema_version: 1,
    fingerprint: "deadbeef0001",
    status: "vulnerability",
    target_file: "x.js",
    category: "race-success",
    severity_self_rated: "low",
    location: { start_line: 1, end_line: 1 },
    narrative: "test",
    stage1_token_usage: { input: 1, output: 1 },
  };
  const runner = fakeSlowRunner({
    prestage: (input) => {
      // Pre-write the finding to the pending subtree so the race-success
      // branch finds a valid finding.json after the budget fires.
      fs.writeFileSync(path.join(input.targetSubtree, "finding.json"), JSON.stringify(finding));
    },
    // Resolve after 200 ms; the 1-s budget fires first only if it's set <200ms.
    // We set the budget to 0 so the timer fires synchronously, then the child
    // done promise resolves after a 200 ms delay.
    delayMs: 200,
  });
  const result = await invokeStage1({
    targetFile: "x.js",
    runDir,
    pendingSubtree,
    repoRoot: runDir,
    config: {
      ...DEFAULT_CONFIG,
      budgets: { ...DEFAULT_CONFIG.budgets, stage1_per_finding_seconds: 0 },
    },
    runner,
    clock: systemClock,
    logger: nullLogger,
    budgetSeconds: 0,
  });
  assert.equal(result.kind, "vulnerability", `expected vulnerability, got ${JSON.stringify(result)}`);
});

test("stage2: budget timer fires but child exits cleanly with valid outcome → success (no synthetic tier-3)", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "atrace2-"));
  const targetSubtree = path.join(runDir, "targets", "deadbeef0002");
  fs.mkdirSync(targetSubtree, { recursive: true });
  const findingForStage2: Finding = {
    schema_version: 1,
    fingerprint: "deadbeef0002",
    status: "vulnerability",
    target_file: "x.js",
    category: "race-success-2",
    severity_self_rated: "high",
    location: { start_line: 1, end_line: 1 },
    narrative: "test2",
    stage1_token_usage: { input: 1, output: 1 },
  };
  const outcome = {
    schema_version: 1,
    fingerprint: "deadbeef0002",
    tier: 1 as const,
    tier_claim: 1 as const,
    confidence: 100,
    exploit_artifact_path: "exploit.sh",
    test_artifact_path: null,
    execution_record: { exit_code: 0, captured_output: "ok", ran_at: "2026-01-01T00:00:00Z" },
    infra_requirements: null,
    exploit_targets_application: true as const,
    downgrade_reason: null,
    stage2_token_usage: { input: 1, output: 1 },
    stage2_wall_seconds: 1,
  };
  const runner = fakeSlowRunner({
    prestage: (input) => {
      fs.writeFileSync(path.join(input.targetSubtree, "outcome.json"), JSON.stringify(outcome));
      fs.writeFileSync(path.join(input.targetSubtree, "exploit.sh"), "#!/bin/sh\nexit 0\n");
    },
    delayMs: 200,
  });
  const result = await invokeStage2({
    finding: findingForStage2,
    runDir,
    targetSubtree,
    repoRoot: runDir,
    config: {
      ...DEFAULT_CONFIG,
      budgets: { ...DEFAULT_CONFIG.budgets, stage2_per_finding_seconds: 0 },
    },
    runner,
    clock: systemClock,
    logger: nullLogger,
    // FR-17 / sec review M1: an absent probe context now hard-downgrades
    // Tier 1. Provide a startable context so this test exercises the
    // budget-race path it actually targets.
    appProbe: {
      startable: true,
      start_commands: ["true"],
      stop_commands: ["true"],
      port: null,
      health_check_url: null,
      startup_timeout_seconds: 5,
    },
  });
  assert.equal(result.kind, "ok", `expected ok, got ${JSON.stringify(result)}`);
  if (result.kind === "ok") {
    assert.equal(result.outcome.tier, 1, "tier should be 1 (real outcome), not 3 (synthetic)");
    assert.equal(result.outcome.confidence, 100, "confidence should be 100, not 0");
  }
});
