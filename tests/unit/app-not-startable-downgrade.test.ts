import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAppNotStartableDowngrade } from "../../src/stage2/tier-validate.js";
import type { Outcome } from "../../src/stage2/schema.js";

function baseOutcome(over: Partial<Outcome>): Outcome {
  return {
    schema_version: 1,
    fingerprint: "abcdef012345",
    tier: 1,
    tier_claim: 1,
    confidence: 100,
    exploit_artifact_path: "exploit.sh",
    test_artifact_path: null,
    execution_record: { exit_code: 0, captured_output: "ok", ran_at: "2026-05-11T00:00:00Z" },
    infra_requirements: null,
    exploit_targets_application: true,
    downgrade_reason: null,
    stage2_token_usage: { input: 0, output: 0 },
    stage2_wall_seconds: 0,
    ...over,
  };
}

test("applyAppNotStartableDowngrade: Tier 1 downgrades to Tier 2 with reason", () => {
  const o = applyAppNotStartableDowngrade(baseOutcome({ tier: 1, tier_claim: 1 }));
  assert.equal(o.tier, 2);
  assert.equal(o.downgrade_reason, "app_not_startable");
  assert.equal(o.exploit_targets_application, false);
});

test("applyAppNotStartableDowngrade: Tier 2 is unchanged", () => {
  const before = baseOutcome({ tier: 2, tier_claim: 2, confidence: 50 });
  const o = applyAppNotStartableDowngrade(before);
  assert.equal(o.tier, 2);
  assert.equal(o.downgrade_reason, null);
});

test("applyAppNotStartableDowngrade: Tier 3 is unchanged", () => {
  const before = baseOutcome({ tier: 3, tier_claim: 3, confidence: 0 });
  const o = applyAppNotStartableDowngrade(before);
  assert.equal(o.tier, 3);
  assert.equal(o.downgrade_reason, null);
});

test("applyAppNotStartableDowngrade: overwrites any prior downgrade_reason (F7.13 / M5)", () => {
  const before = baseOutcome({ tier: 1, downgrade_reason: "already_set" });
  const o = applyAppNotStartableDowngrade(before);
  assert.equal(o.tier, 2);
  // The probe result is engine-authoritative; previous reasons must not
  // shadow `app_not_startable` (architecture §22.6 / decision 31).
  assert.equal(o.downgrade_reason, "app_not_startable");
});
