import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFinding, FindingValidationError } from "../../src/stage1/schema.js";
import { validateOutcome, OutcomeValidationError } from "../../src/stage2/schema.js";

test("finding rejects uppercase fingerprint", () => {
  const f = {
    schema_version: 1,
    fingerprint: "ABCDEF012345",
    status: "no_finding",
    target_file: "x.js",
    category: "n",
    no_finding_reason: "clean",
    stage1_token_usage: { input: 1, output: 1 },
  };
  assert.throws(() => validateFinding(f), FindingValidationError);
});

test("finding rejects fingerprint of wrong length", () => {
  const f = {
    schema_version: 1,
    fingerprint: "abc",
    status: "no_finding",
    target_file: "x.js",
    category: "n",
    no_finding_reason: "clean",
    stage1_token_usage: { input: 1, output: 1 },
  };
  assert.throws(() => validateFinding(f), FindingValidationError);
});

test("outcome rejects fractional confidence", () => {
  const o = {
    schema_version: 1,
    fingerprint: "aaaaaaaaaaaa",
    tier: 1,
    tier_claim: 1,
    confidence: 1.5,
    exploit_artifact_path: "exploit.sh",
    test_artifact_path: null,
    execution_record: { exit_code: 0, captured_output: "ok", ran_at: "2026-01-01T00:00:00Z" },
    infra_requirements: null,
    downgrade_reason: null,
    stage2_token_usage: { input: 1, output: 1 },
    stage2_wall_seconds: 1,
  };
  assert.throws(() => validateOutcome(o), OutcomeValidationError);
});

test("outcome rejects confidence above 100", () => {
  const o = {
    schema_version: 1,
    fingerprint: "aaaaaaaaaaaa",
    tier: 1,
    tier_claim: 1,
    confidence: 101,
    exploit_artifact_path: "exploit.sh",
    test_artifact_path: null,
    execution_record: { exit_code: 0, captured_output: "ok", ran_at: "2026-01-01T00:00:00Z" },
    infra_requirements: null,
    downgrade_reason: null,
    stage2_token_usage: { input: 1, output: 1 },
    stage2_wall_seconds: 1,
  };
  assert.throws(() => validateOutcome(o), OutcomeValidationError);
});

test("outcome rejects tier=4", () => {
  const o = {
    schema_version: 1,
    fingerprint: "aaaaaaaaaaaa",
    tier: 4,
    tier_claim: 1,
    confidence: 0,
    exploit_artifact_path: null,
    test_artifact_path: null,
    execution_record: null,
    infra_requirements: null,
    downgrade_reason: null,
    stage2_token_usage: { input: 1, output: 1 },
    stage2_wall_seconds: 1,
  };
  assert.throws(() => validateOutcome(o), OutcomeValidationError);
});

// --- Artifact-path pattern (security re-review M1) ---

function baseTier1Outcome(extra: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    schema_version: 1,
    fingerprint: "aaaaaaaaaaaa",
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
    ...extra,
  };
}

test("outcome rejects exploit_artifact_path with '..' traversal", () => {
  assert.throws(
    () => validateOutcome(baseTier1Outcome({ exploit_artifact_path: "../../etc/passwd" })),
    OutcomeValidationError,
  );
});

test("outcome rejects absolute exploit_artifact_path", () => {
  assert.throws(
    () => validateOutcome(baseTier1Outcome({ exploit_artifact_path: "/etc/passwd" })),
    OutcomeValidationError,
  );
});

test("outcome rejects hidden-file exploit_artifact_path", () => {
  assert.throws(
    () => validateOutcome(baseTier1Outcome({ exploit_artifact_path: ".hidden" })),
    OutcomeValidationError,
  );
});

test("outcome rejects oversized (>256-byte) artifact path", () => {
  assert.throws(
    () => validateOutcome(baseTier1Outcome({ exploit_artifact_path: "a".repeat(257) })),
    OutcomeValidationError,
  );
});

test("outcome accepts subdir/test.js as test_artifact_path", () => {
  const o = baseTier1Outcome({
    tier: 2,
    confidence: 50,
    exploit_artifact_path: null,
    test_artifact_path: "subdir/test.js",
    execution_record: { exit_code: 1, captured_output: "ok", ran_at: "2026-01-01T00:00:00Z" },
  });
  assert.doesNotThrow(() => validateOutcome(o));
});
