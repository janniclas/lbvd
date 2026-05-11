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

function fixtureRoot(): string {
  return path.join(repoRoot(), "tests", "fixtures", "canned-agents");
}

function tsxBin(): string {
  return path.join(repoRoot(), "node_modules", ".bin", "tsx");
}

function makePlantedRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atrmr-"));
  gitInit(root);
  fs.writeFileSync(path.join(root, "eval.js"), "eval(process.argv[2]);\n");
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
  return root;
}

test("resume after partial reporting → exactly one branch + one issue", () => {
  const root = makePlantedRepo();
  const env = {
    ...process.env,
    LBVD_RUNNER: "fixture",
    LBVD_FIXTURE_SCENARIO: "baseline",
    LBVD_FIXTURE_ROOT: fixtureRoot(),
  };
  const cli = path.join(repoRoot(), "src", "cli.ts");
  const r1 = spawnSync(
    tsxBin(),
    [cli, "scan-all", "--config", "lbvd.yaml", "--run-id", "20260509T120300Z-feedface"],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.equal(r1.status, 0, `stderr1: ${r1.stderr}`);

  // Snapshot the branch + issue before fault injection.
  const runDir = path.join(root, ".lbvd", "20260509T120300Z-feedface");
  const branchesBefore = fs.readdirSync(path.join(runDir, "local-report", "branches"));
  const issuesBefore = fs.readdirSync(path.join(runDir, "local-report", "issues"));
  assert.equal(branchesBefore.length, 1, "expected exactly 1 branch from initial run");
  assert.equal(issuesBefore.length, 1, "expected exactly 1 finding issue from initial run");

  // Force the eval.js target back to reporting_issue (already has branch_url, no issue_url).
  // This simulates a crash *between* branch push and finding-issue creation.
  const stateFile = path.join(runDir, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const t = state.targets["eval.js"];
  t.state = "reporting_issue";
  // Keep branch_url, drop issue_url. The branch artifact remains on disk.
  t.issue_url = null;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  // Remove the issue file from the local report to reset the side-effect.
  for (const f of fs.readdirSync(path.join(runDir, "local-report", "issues"))) {
    fs.rmSync(path.join(runDir, "local-report", "issues", f), { force: true });
  }

  const r2 = spawnSync(
    tsxBin(),
    [cli, "resume", "20260509T120300Z-feedface"],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.equal(r2.status, 0, `stderr2: ${r2.stderr}`);

  const branchesAfter = fs.readdirSync(path.join(runDir, "local-report", "branches"));
  const issuesAfter = fs.readdirSync(path.join(runDir, "local-report", "issues"));
  assert.equal(branchesAfter.length, 1, "still exactly 1 branch after resume");
  assert.equal(issuesAfter.length, 1, "exactly 1 finding issue after resume");
});
