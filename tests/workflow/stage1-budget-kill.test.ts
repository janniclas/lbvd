import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
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

test("stage 1 over its wall-clock budget terminates as failed", () => {
  // Repo with a single target whose stage-1 fixture sleeps past the 1s cap.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ats1bud-"));
  gitInit(root);
  fs.writeFileSync(path.join(root, "hang.js"), "// hang\n");
  fs.writeFileSync(
    path.join(root, "lbvd.yaml"),
    [
      "concurrency: 1",
      "output:",
      "  mode: local",
      "runner:",
      "  kind: fixture",
      "budgets:",
      "  stage1_per_finding_seconds: 1",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

  // Build a one-target fixture scenario whose stage1 hangs for 5s and never writes finding.json.
  const fixtureScenarioRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atfix-"));
  const scenarioDir = path.join(fixtureScenarioRoot, "hang");
  fs.mkdirSync(path.join(scenarioDir, "hang.js"), { recursive: true });
  fs.writeFileSync(
    path.join(scenarioDir, "hang.js", "stage1.json"),
    JSON.stringify({ exit_after_ms: 5000 }, null, 2),
  );
  // No stage2.json — never reached.

  const tsxBin = path.join(repoRoot(), "node_modules", ".bin", "tsx");
  const result = spawnSync(
    tsxBin,
    [
      path.join(repoRoot(), "src", "cli.ts"),
      "scan-all",
      "--config",
      "lbvd.yaml",
      "--run-id",
      "20260509T120700Z-cafefeed",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        LBVD_RUNNER: "fixture",
        LBVD_FIXTURE_SCENARIO: "hang",
        LBVD_FIXTURE_ROOT: fixtureScenarioRoot,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);

  const runDir = path.join(root, ".lbvd", "20260509T120700Z-cafefeed");
  const state = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8")) as {
    targets: Record<string, { state: string }>;
  };
  assert.equal(state.targets["hang.js"]?.state, "failed", "stage 1 budget kill -> failed");

  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8")) as {
    counts_by_tier: { failed: number };
  };
  assert.equal(manifest.counts_by_tier.failed, 1, "manifest counts the failure");
});
