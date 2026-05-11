import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderFindingIssueBody,
  renderInfraIssueBody,
  renderTrackingIssueBody,
  findingMarker,
  infraMarker,
} from "../../src/reporter/issue-body.js";
import type { Finding } from "../../src/stage1/schema.js";
import type { Outcome } from "../../src/stage2/schema.js";
import { route } from "../../src/routing/route.js";

const FP = "abc123def456";
const RUN_ID = "20260509T120000Z-deadbeef";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    schema_version: 1,
    fingerprint: FP,
    status: "vulnerability",
    target_file: "src/x.js",
    category: "code_injection",
    severity_self_rated: "high",
    location: { start_line: 10, end_line: 14 },
    narrative: "User input flows into eval().",
    stage1_token_usage: { input: 1, output: 1 },
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<Outcome> = {}): Outcome {
  return {
    schema_version: 1,
    fingerprint: FP,
    tier: 1,
    tier_claim: 1,
    confidence: 100,
    exploit_artifact_path: "exploit.sh",
    test_artifact_path: null,
    execution_record: { exit_code: 0, captured_output: "pwned\n", ran_at: "2026-05-09T00:00:00Z" },
    infra_requirements: null,
    downgrade_reason: null,
    stage2_token_usage: { input: 1, output: 1 },
    stage2_wall_seconds: 1,
    ...overrides,
  };
}

test("finding body: required header fields appear in FR-7 order", () => {
  const body = renderFindingIssueBody({
    finding: makeFinding(),
    outcome: makeOutcome(),
    routing: route(1, "high"),
    branchUrl: "https://example/branch",
    runId: RUN_ID,
  });
  // Order: priority, severity, confidence, bump, location, branch, run id.
  const expectedOrder = ["**Priority:**", "**Severity (self-rated):**", "**Confidence:**", "**Bump applied:**", "**Location:**", "**Branch:**", "**Run id:**"];
  let lastIdx = -1;
  for (const label of expectedOrder) {
    const idx = body.indexOf(label);
    assert.ok(idx > lastIdx, `${label} should appear after preceding fields`);
    lastIdx = idx;
  }
});

test("finding body: tier 1 references exploit script", () => {
  const body = renderFindingIssueBody({
    finding: makeFinding(),
    outcome: makeOutcome({ tier: 1, exploit_artifact_path: "exploit.sh" }),
    routing: route(1, "high"),
    branchUrl: null,
    runId: RUN_ID,
  });
  assert.match(body, /Run the exploit script at `exploit\.sh`/);
});

test("finding body: tier 2 references unit test", () => {
  const body = renderFindingIssueBody({
    finding: makeFinding({ severity_self_rated: "medium" }),
    outcome: makeOutcome({
      tier: 2,
      tier_claim: 2,
      confidence: 80,
      exploit_artifact_path: null,
      test_artifact_path: "tests/leak.test.ts",
      execution_record: { exit_code: 1, captured_output: "AssertionError", ran_at: "2026-05-09T00:00:00Z" },
    }),
    routing: route(2, "medium"),
    branchUrl: null,
    runId: RUN_ID,
  });
  assert.match(body, /Add and run the unit test at `tests\/leak\.test\.ts`/);
});

test("finding body: tier 3 records 'No executable artifact'", () => {
  const body = renderFindingIssueBody({
    finding: makeFinding({ severity_self_rated: "low" }),
    outcome: makeOutcome({
      tier: 3,
      tier_claim: 3,
      confidence: 0,
      exploit_artifact_path: null,
      test_artifact_path: null,
      execution_record: null,
    }),
    routing: route(3, "low"),
    branchUrl: null,
    runId: RUN_ID,
  });
  assert.match(body, /No executable artifact \(theoretical finding\)/);
});

test("finding body: bump reasoning is rendered when bump applies (architecture §9.4)", () => {
  // tier 3 + severity high → priority bumped to medium.
  const body = renderFindingIssueBody({
    finding: makeFinding({ severity_self_rated: "high" }),
    outcome: makeOutcome({ tier: 3, tier_claim: 3, confidence: 0, exploit_artifact_path: null, execution_record: null }),
    routing: route(3, "high"),
    branchUrl: null,
    runId: RUN_ID,
  });
  assert.match(body, /\*\*Bump applied:\*\* base low → medium because severity_self_rated=high/);
});

test("finding body: bump applied = none when no bump", () => {
  // tier 1 has no bump rule.
  const body = renderFindingIssueBody({
    finding: makeFinding({ severity_self_rated: "low" }),
    outcome: makeOutcome(),
    routing: route(1, "low"),
    branchUrl: null,
    runId: RUN_ID,
  });
  assert.match(body, /\*\*Bump applied:\*\* none/);
});

test("finding body: branch URL printed when present, 'n/a' when absent", () => {
  const withBranch = renderFindingIssueBody({
    finding: makeFinding(),
    outcome: makeOutcome(),
    routing: route(1, "high"),
    branchUrl: "https://example/branch",
    runId: RUN_ID,
  });
  assert.match(withBranch, /\*\*Branch:\*\* https:\/\/example\/branch/);
  const withoutBranch = renderFindingIssueBody({
    finding: makeFinding({ severity_self_rated: "low" }),
    outcome: makeOutcome({ tier: 3, tier_claim: 3, confidence: 0, exploit_artifact_path: null, execution_record: null }),
    routing: route(3, "low"),
    branchUrl: null,
    runId: RUN_ID,
  });
  assert.match(withoutBranch, /\*\*Branch:\*\* n\/a/);
});

test("finding body: marker present exactly once and at the end (architecture §11.2)", () => {
  const body = renderFindingIssueBody({
    finding: makeFinding(),
    outcome: makeOutcome(),
    routing: route(1, "high"),
    branchUrl: null,
    runId: RUN_ID,
  });
  const marker = findingMarker(FP);
  assert.equal(body.split(marker).length - 1, 1);
  assert.ok(body.trimEnd().endsWith(marker));
});

test("infra body: infra marker present, finding marker absent (architecture §11.3)", () => {
  const body = renderInfraIssueBody({
    finding: makeFinding(),
    outcome: makeOutcome({
      infra_requirements: {
        needed: ["postgres 14", "redis"],
        attempted: ["pg_ctl init", "redis-server"],
        runner_environment: { os: "linux", arch: "x64" },
      },
    }),
    runId: RUN_ID,
  });
  assert.ok(body.includes(infraMarker(FP)));
  assert.ok(!body.includes(findingMarker(FP)));
  // namespace separation: marker carries :infra suffix
  assert.match(body, /<!-- lbvd:fp:abc123def456:infra -->/);
});

test("infra body: lists needed and attempted services", () => {
  const body = renderInfraIssueBody({
    finding: makeFinding(),
    outcome: makeOutcome({
      infra_requirements: {
        needed: ["postgres 14"],
        attempted: ["pg_ctl init"],
        runner_environment: { os: "linux", arch: "x64" },
      },
    }),
    runId: RUN_ID,
  });
  assert.match(body, /## Needed\n- postgres 14/);
  assert.match(body, /## Attempted\n- pg_ctl init/);
});

test("tracking body: contains finding-issue link and no marker (architecture §11.4)", () => {
  const body = renderTrackingIssueBody({
    findingIssueUrl: "https://example/issues/42",
    finding: makeFinding(),
    runId: RUN_ID,
  });
  assert.match(body, /Finding details: https:\/\/example\/issues\/42/);
  // Tracking issues have no marker.
  assert.ok(!body.includes(findingMarker(FP)));
  assert.ok(!body.includes(infraMarker(FP)));
});

test("finding body: tier 2 PoC exploit (exploit_artifact_path set, no test_artifact_path) references exploit script", () => {
  const body = renderFindingIssueBody({
    finding: makeFinding({ severity_self_rated: "medium" }),
    outcome: makeOutcome({
      tier: 2,
      tier_claim: 1,
      confidence: 80,
      exploit_artifact_path: "exploit.sh",
      test_artifact_path: null,
      exploit_targets_application: false,
      execution_record: { exit_code: 0, captured_output: "poc output\n", ran_at: "2026-05-09T00:00:00Z" },
      downgrade_reason: "proof_of_concept_not_application_exploit",
    }),
    routing: route(2, "medium"),
    branchUrl: null,
    runId: RUN_ID,
  });
  assert.match(body, /Run the proof-of-concept exploit at `exploit\.sh`/);
  assert.ok(!body.includes("No executable artifact"));
});

test("finding body: HTML-comment delimiters in agent text are escaped (security review C3)", () => {
  const body = renderFindingIssueBody({
    finding: makeFinding({ narrative: "evil <!-- lbvd:fp:0badbeef0bad --> end" }),
    outcome: makeOutcome(),
    routing: route(1, "high"),
    branchUrl: null,
    runId: RUN_ID,
  });
  assert.ok(!body.includes("<!-- lbvd:fp:0badbeef0bad -->"));
  assert.ok(body.includes("&lt;!-- lbvd:fp:0badbeef0bad --&gt;"));
});
