import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

function repoRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

interface CellInput {
  fingerprint: string;
  filename: string;
  tier: 1 | 2 | 3;
  severity: "low" | "medium" | "high";
}

const CELLS: CellInput[] = [
  { fingerprint: "111111111111", filename: "t1l.js", tier: 1, severity: "low" },
  { fingerprint: "222222222222", filename: "t1m.js", tier: 1, severity: "medium" },
  { fingerprint: "333333333333", filename: "t1h.js", tier: 1, severity: "high" },
  { fingerprint: "444444444444", filename: "t2l.js", tier: 2, severity: "low" },
  { fingerprint: "555555555555", filename: "t2m.js", tier: 2, severity: "medium" },
  { fingerprint: "666666666666", filename: "t2h.js", tier: 2, severity: "high" },
  { fingerprint: "777777777777", filename: "t3l.js", tier: 3, severity: "low" },
  { fingerprint: "888888888888", filename: "t3m.js", tier: 3, severity: "medium" },
  { fingerprint: "999999999999", filename: "t3h.js", tier: 3, severity: "high" },
];

function writeStartableProbe(scenarioRoot: string): void {
  const probeDir = path.join(scenarioRoot, "probe");
  fs.mkdirSync(probeDir, { recursive: true });
  const probe = {
    schema_version: 1,
    startable: true,
    start_commands: ["echo start"],
    stop_commands: ["echo stop"],
    port: 3000,
    health_check_url: null,
    startup_timeout_seconds: 10,
    pre_conditions: [],
    probe_narrative: "fixture: startable",
    tried: true,
    successfully_started: true,
    failure_reason: null,
    probe_token_usage: { input: 0, output: 0 },
    probe_wall_seconds: 0,
  };
  fs.writeFileSync(path.join(probeDir, "app-probe.json"), JSON.stringify(probe, null, 2));
}

function makeFixtureFiles(scenarioRoot: string): void {
  writeStartableProbe(scenarioRoot);
  for (const c of CELLS) {
    const dir = path.join(scenarioRoot, c.filename);
    fs.mkdirSync(dir, { recursive: true });
    const finding = {
      schema_version: 1,
      fingerprint: c.fingerprint,
      status: "vulnerability",
      target_file: c.filename,
      category: `cell_t${c.tier}_${c.severity}`,
      severity_self_rated: c.severity,
      location: { start_line: 1, end_line: 1 },
      narrative: "narrative",
      stage1_token_usage: { input: 1, output: 1 },
    };
    const outcome = {
      schema_version: 1,
      fingerprint: c.fingerprint,
      tier: c.tier,
      tier_claim: c.tier,
      confidence: c.tier === 1 ? 100 : c.tier === 2 ? 50 : 0,
      exploit_artifact_path: c.tier === 1 ? "exploit.sh" : null,
      test_artifact_path: c.tier === 2 ? "unit-test.js" : null,
      execution_record:
        c.tier === 1
          ? { exit_code: 0, captured_output: "ok", ran_at: "2026-01-01T00:00:00Z" }
          : c.tier === 2
            ? { exit_code: 1, captured_output: "fail", ran_at: "2026-01-01T00:00:00Z" }
            : null,
      infra_requirements: null,
      exploit_targets_application: c.tier === 1 ? true : null,
      downgrade_reason: null,
      stage2_token_usage: { input: 1, output: 1 },
      stage2_wall_seconds: 1,
    };
    fs.writeFileSync(path.join(dir, "stage1.json"), JSON.stringify({ finding }, null, 2));
    const stage2: { outcome: typeof outcome; artifacts?: { path: string; content: string }[] } = {
      outcome,
    };
    if (c.tier === 1) {
      stage2.artifacts = [{ path: "exploit.sh", content: "#!/bin/sh\nexit 0\n" }];
    } else if (c.tier === 2) {
      stage2.artifacts = [{ path: "unit-test.js", content: "throw new Error('ok');\n" }];
    }
    fs.writeFileSync(path.join(dir, "stage2.json"), JSON.stringify(stage2, null, 2));
  }
}

test("routing table end-to-end: each (tier × severity) cell maps to expected artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atrt-"));
  gitInit(root);
  for (const c of CELLS) {
    fs.writeFileSync(path.join(root, c.filename), "// stub\n");
  }
  fs.writeFileSync(
    path.join(root, "lbvd.yaml"),
    [
      "concurrency: 1",
      "output:",
      "  mode: local",
      "runner:",
      "  kind: fixture",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

  const fixtureScenarioRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atfix-"));
  const scenarioDir = path.join(fixtureScenarioRoot, "rt");
  fs.mkdirSync(scenarioDir);
  makeFixtureFiles(scenarioDir);

  const tsxBin = path.join(repoRoot(), "node_modules", ".bin", "tsx");
  const result = spawnSync(
    tsxBin,
    [path.join(repoRoot(), "src", "cli.ts"), "scan-all", "--config", "lbvd.yaml", "--run-id", "20260509T120600Z-77889900"],
    {
      cwd: root,
      env: {
        ...process.env,
        LBVD_RUNNER: "fixture",
        LBVD_FIXTURE_SCENARIO: "rt",
        LBVD_FIXTURE_ROOT: fixtureScenarioRoot,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);

  const runDir = path.join(root, ".lbvd", "20260509T120600Z-77889900");
  const issues = fs.readdirSync(path.join(runDir, "local-report", "issues"));
  // Each cell produces exactly one finding issue (9 total).
  assert.equal(issues.length, 9, `expected 9 issues, got ${issues.length}`);
  // Tier 1 + tier 2 produce branches (6 total: 3 exploit + 3 test).
  const branchesRoot = path.join(runDir, "local-report", "branches");
  const exploitDir = path.join(branchesRoot, "lbvd", "exploit");
  const testDir = path.join(branchesRoot, "lbvd", "test");
  const exploitBranches = fs.existsSync(exploitDir) ? fs.readdirSync(exploitDir) : [];
  const testBranches = fs.existsSync(testDir) ? fs.readdirSync(testDir) : [];
  assert.equal(exploitBranches.length, 3, `expected 3 tier1 branches, got ${exploitBranches.length}`);
  assert.equal(testBranches.length, 3, `expected 3 tier2 branches, got ${testBranches.length}`);

  // Tier 1 high → priority high (label in body)
  const t1h = issues.find((n) => n.includes("333333333333"))!;
  const body = fs.readFileSync(path.join(runDir, "local-report", "issues", t1h), "utf8");
  assert.match(body, /priority:high/);

  // Tier 3 medium → bumped from low → medium with bump_reason recorded
  const t3m = issues.find((n) => n.includes("888888888888"))!;
  const t3mBody = fs.readFileSync(path.join(runDir, "local-report", "issues", t3m), "utf8");
  assert.match(t3mBody, /base low → medium/);
});
