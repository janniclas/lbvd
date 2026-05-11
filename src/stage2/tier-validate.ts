import * as fs from "node:fs";
import type { Outcome } from "./schema.js";
import { confineToParent, PathBoundaryError } from "../util/safe-path.js";

export interface ValidateOpts {
  outcome: Outcome;
  targetSubtree: string;
}

function artifactExists(targetSubtree: string, p: string | null): boolean {
  if (p === null) return false;
  try {
    const abs = confineToParent({ parent: targetSubtree, candidate: p, mustExist: true });
    return fs.existsSync(abs);
  } catch (e) {
    if (e instanceof PathBoundaryError) return false;
    throw e;
  }
}

function tier1Substantiated(o: Outcome, targetSubtree: string): boolean {
  return (
    artifactExists(targetSubtree, o.exploit_artifact_path) &&
    o.execution_record !== null &&
    o.execution_record.exit_code === 0
  );
}

// Returns the downgrade reason string if Tier 1 cannot be upheld, null if it can.
// exploit_targets_application is agent self-reported (advisory, not engine-verifiable):
// a determined agent can still write true to maintain Tier 1 status, which is the
// same as pre-change behavior. The gate is safe-direction: null/false/undefined → downgrade.
function tier1Downgrade(o: Outcome, targetSubtree: string): string | null {
  if (!tier1Substantiated(o, targetSubtree)) return "claim_unsubstantiated";
  if (o.exploit_targets_application !== true) return "proof_of_concept_not_application_exploit";
  return null;
}

// For tier-2 unit tests: execution must have run AND failed (exit_code !== 0 proves it
// tests the vulnerable behavior and would pass after a fix). Implementation §3.3.
// For PoC exploits downgraded from Tier 1: only an execution record is required;
// exit_code 0 is the correct signal for a successful PoC demonstration.
function tier2Substantiated(o: Outcome, targetSubtree: string): boolean {
  if (artifactExists(targetSubtree, o.test_artifact_path)) {
    return o.execution_record !== null && o.execution_record.exit_code !== 0;
  }
  return artifactExists(targetSubtree, o.exploit_artifact_path) && o.execution_record !== null;
}

export function validateAndFix(opts: ValidateOpts): Outcome {
  const o = { ...opts.outcome };
  // Guard covers both tier=1 and tier_claim=1 to handle the unusual case where an agent
  // sets tier=1 while under-claiming tier_claim=2. Outcomes written before
  // exploit_targets_application was introduced (field undefined) fail the === true check
  // and will be downgraded on re-validation.
  if (o.tier === 1 || o.tier_claim === 1) {
    const reason = tier1Downgrade(o, opts.targetSubtree);
    if (reason !== null) {
      o.tier = 2;
      o.downgrade_reason = o.downgrade_reason ?? reason;
    }
  }
  if (o.tier === 2 && !tier2Substantiated(o, opts.targetSubtree)) {
    o.tier = 3;
    o.downgrade_reason = o.downgrade_reason ?? "claim_unsubstantiated";
  }
  if (o.tier === 1) o.confidence = 100;
  if (o.tier === 3) o.confidence = 0;
  if (o.tier === 2) o.confidence = clamp(o.confidence, 0, 100);
  return o;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * FR-17 / architecture §22.6 / impl F7.13: when the probe declared the
 * application not startable, any Tier 1 claim is hard-downgraded to
 * Tier 2 with `downgrade_reason = "app_not_startable"`. The downgrade
 * is engine-enforced and *overrides* any prior `downgrade_reason` the
 * agent may have written — the probe result is the authoritative cause
 * (post-impl review M5). Tier 2 and Tier 3 outcomes are returned
 * unchanged because `applyAppNotStartableDowngrade` is invoked only on
 * the Tier 1 path.
 */
export function applyAppNotStartableDowngrade(outcome: Outcome): Outcome {
  if (outcome.tier !== 1) return outcome;
  const next: Outcome = {
    ...outcome,
    tier: 2,
    exploit_targets_application: false,
    downgrade_reason: "app_not_startable",
    confidence: clamp(outcome.confidence, 0, 100),
  };
  return next;
}

export function syntheticBudgetKillOutcome(fingerprint: string, wallSeconds: number): Outcome {
  return {
    schema_version: 1,
    fingerprint,
    tier: 3,
    tier_claim: 3,
    confidence: 0,
    exploit_artifact_path: null,
    test_artifact_path: null,
    execution_record: null,
    infra_requirements: null,
    exploit_targets_application: null,
    downgrade_reason: "wall_clock_cap",
    stage2_token_usage: { input: 0, output: 0 },
    stage2_wall_seconds: wallSeconds,
  };
}
