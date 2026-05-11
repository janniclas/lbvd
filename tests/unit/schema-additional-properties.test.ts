import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFinding, FindingValidationError } from "../../src/stage1/schema.js";
import { validateOutcome, OutcomeValidationError } from "../../src/stage2/schema.js";
import { validateRunState, StateValidationError } from "../../src/dispatcher/state.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { RunState } from "../../src/dispatcher/state.js";

test("finding rejects unknown extra top-level key", () => {
  const valid = {
    schema_version: 1,
    fingerprint: "aaaaaaaaaaaa",
    status: "no_finding",
    target_file: "x.js",
    category: "none",
    no_finding_reason: "clean",
    stage1_token_usage: { input: 1, output: 1 },
  };
  // Sanity-check: the valid version validates.
  assert.doesNotThrow(() => validateFinding(valid));
  const tampered = { ...valid, evil: 1 };
  assert.throws(() => validateFinding(tampered), FindingValidationError);
});

test("finding rejects extra key inside nested location object", () => {
  const f = {
    schema_version: 1,
    fingerprint: "bbbbbbbbbbbb",
    status: "vulnerability",
    target_file: "x.js",
    category: "eval",
    severity_self_rated: "high",
    location: { start_line: 1, end_line: 2, evil: 99 },
    narrative: "n",
    stage1_token_usage: { input: 1, output: 1 },
  };
  assert.throws(() => validateFinding(f), FindingValidationError);
});

test("outcome rejects unknown extra key", () => {
  const valid = {
    schema_version: 1,
    fingerprint: "cccccccccccc",
    tier: 1,
    tier_claim: 1,
    confidence: 100,
    exploit_artifact_path: "exploit.sh",
    test_artifact_path: null,
    execution_record: { exit_code: 0, captured_output: "ok", ran_at: "2026-01-01T00:00:00Z" },
    infra_requirements: null,
    downgrade_reason: null,
    stage2_token_usage: { input: 1, output: 1 },
    stage2_wall_seconds: 1,
  };
  assert.doesNotThrow(() => validateOutcome(valid));
  assert.throws(() => validateOutcome({ ...valid, evil: 1 }), OutcomeValidationError);
});

test("state rejects unknown extra key on a target", () => {
  const valid: RunState = {
    schema_version: 1,
    run_id: "20260509T120000Z-deadbeef",
    config_snapshot: { ...DEFAULT_CONFIG },
    started_at: "2026-05-09T12:00:00.000Z",
    ended_at: null,
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
    terminations: [],
  };
  assert.doesNotThrow(() => validateRunState(valid));
  const tampered = JSON.parse(JSON.stringify(valid)) as RunState & { targets: Record<string, Record<string, unknown>> };
  tampered.targets["x.js"]!["evil"] = 1;
  assert.throws(() => validateRunState(tampered as RunState), StateValidationError);
});
