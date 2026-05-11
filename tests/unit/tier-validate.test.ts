import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateAndFix, syntheticBudgetKillOutcome } from "../../src/stage2/tier-validate.js";
import type { Outcome } from "../../src/stage2/schema.js";

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "atut-"));
  return d;
}

const baseOutcome: Outcome = {
  schema_version: 1,
  fingerprint: "abc123def456",
  tier: 1,
  tier_claim: 1,
  confidence: 80,
  exploit_artifact_path: "exploit.sh",
  test_artifact_path: null,
  execution_record: { exit_code: 0, captured_output: "ok", ran_at: "2026-01-01T00:00:00Z" },
  infra_requirements: null,
  exploit_targets_application: true,
  downgrade_reason: null,
  stage2_token_usage: { input: 100, output: 50 },
  stage2_wall_seconds: 5,
};

test("tier1 substantiated with exploit_targets_application=true stays tier1", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "exploit.sh"), "#!/bin/sh\necho ok");
  const r = validateAndFix({ outcome: { ...baseOutcome }, targetSubtree: dir });
  assert.equal(r.tier, 1);
  assert.equal(r.confidence, 100);
});

test("tier1 unsubstantiated (no artifact) downgrades to tier 3", () => {
  const dir = tmpDir(); // no exploit file
  const r = validateAndFix({ outcome: { ...baseOutcome }, targetSubtree: dir });
  assert.equal(r.tier, 3);
  assert.equal(r.confidence, 0);
  assert.match(r.downgrade_reason ?? "", /claim_unsubstantiated/);
});

test("tier1 exploit_targets_application=false (PoC) downgrades to tier 2", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "exploit.sh"), "#!/bin/sh\necho poc");
  const o: Outcome = { ...baseOutcome, exploit_targets_application: false };
  const r = validateAndFix({ outcome: o, targetSubtree: dir });
  assert.equal(r.tier, 2);
  assert.match(r.downgrade_reason ?? "", /proof_of_concept_not_application_exploit/);
});

test("tier1 exploit_targets_application=null (unset) downgrades to tier 2", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "exploit.sh"), "#!/bin/sh\necho poc");
  const o: Outcome = { ...baseOutcome, exploit_targets_application: null };
  const r = validateAndFix({ outcome: o, targetSubtree: dir });
  assert.equal(r.tier, 2);
  assert.match(r.downgrade_reason ?? "", /proof_of_concept_not_application_exploit/);
});

test("PoC exploit downgraded to tier2 is substantiated by exploit artifact (confidence preserved)", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "exploit.sh"), "#!/bin/sh\necho poc");
  const o: Outcome = { ...baseOutcome, exploit_targets_application: false };
  const r = validateAndFix({ outcome: o, targetSubtree: dir });
  assert.equal(r.tier, 2);
  assert.equal(r.confidence, 80);
});

test("tier2 direct claim with exploit_artifact_path (no test artifact) is substantiated", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "exploit.sh"), "#!/bin/sh\necho poc");
  const o: Outcome = {
    ...baseOutcome,
    tier: 2,
    tier_claim: 2,
    confidence: 50,
    exploit_targets_application: false,
    test_artifact_path: null,
  };
  const r = validateAndFix({ outcome: o, targetSubtree: dir });
  assert.equal(r.tier, 2);
});

test("tier2 unit-test with exit_code=0 (passing test) downgrades to tier 3", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "unit-test.js"), "// test");
  const o: Outcome = {
    ...baseOutcome,
    tier: 2,
    tier_claim: 2,
    confidence: 50,
    exploit_artifact_path: null,
    exploit_targets_application: null,
    test_artifact_path: "unit-test.js",
    execution_record: { exit_code: 0, captured_output: "pass", ran_at: "2026-01-01T00:00:00Z" },
  };
  const r = validateAndFix({ outcome: o, targetSubtree: dir });
  // A unit test that exits 0 (passes) does not prove the bug exists → downgrade
  assert.equal(r.tier, 3);
  assert.match(r.downgrade_reason ?? "", /claim_unsubstantiated/);
});

test("budget-kill produces tier 3, confidence 0", () => {
  const o = syntheticBudgetKillOutcome("aaa111bbb222", 600);
  assert.equal(o.tier, 3);
  assert.equal(o.confidence, 0);
  assert.equal(o.downgrade_reason, "wall_clock_cap");
});
