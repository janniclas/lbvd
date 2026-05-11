import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

function makePlantedRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atrepo-"));
  gitInit(root);
  fs.writeFileSync(path.join(root, "eval.js"), "eval(process.argv[2]);\n");
  fs.writeFileSync(path.join(root, "timing.js"), "function eq(a,b){return a===b;}\n".repeat(10));
  fs.writeFileSync(path.join(root, "clean.js"), "export const add = (a,b) => a+b;\n");
  fs.writeFileSync(
    path.join(root, "lbvd.yaml"),
    [
      "concurrency: 1",
      "output:",
      "  mode: local",
      "preflight:",
      "  enabled_on_substrate: web-sandbox",
      "runner:",
      "  kind: fixture",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return root;
}

function repoRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

test("scan-all baseline: 1 tier1, 1 tier3, 1 no_finding", () => {
  const root = makePlantedRepo();
  const cli = path.join(repoRoot(), "src", "cli.ts");
  const fixtureRoot = path.join(repoRoot(), "tests", "fixtures", "canned-agents");
  const tsxBin = path.join(repoRoot(), "node_modules", ".bin", "tsx");
  const result = spawnSync(
    tsxBin,
    [cli, "scan-all", "--config", "lbvd.yaml", "--run-id", "20260509T120000Z-deadbeef"],
    {
      cwd: root,
      env: {
        ...process.env,
        LBVD_RUNNER: "fixture",
        LBVD_FIXTURE_SCENARIO: "baseline",
        LBVD_FIXTURE_ROOT: fixtureRoot,
        NODE_PATH: path.join(repoRoot(), "node_modules"),
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);

  const runDir = path.join(root, ".lbvd", "20260509T120000Z-deadbeef");
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8")) as {
    counts_by_tier: { tier1: number; tier2: number; tier3: number; no_finding: number; failed: number };
    outcomes: { target_file: string; state: string; tier: number | null }[];
  };
  assert.equal(manifest.counts_by_tier.tier1, 1, "expected 1 tier1");
  assert.equal(manifest.counts_by_tier.tier3, 1, "expected 1 tier3");
  assert.equal(manifest.counts_by_tier.no_finding, 1, "expected 1 no_finding");

  const issues = fs.readdirSync(path.join(runDir, "local-report", "issues"));
  assert.equal(issues.length, 2, "expected 2 finding issues (tier1 + tier3)");
  const branches = fs.readdirSync(path.join(runDir, "local-report", "branches"));
  assert.equal(branches.length, 1, "expected 1 branch (tier1 only)");

  // Marker present in tier1 issue body
  const tier1Body = fs.readFileSync(
    path.join(runDir, "local-report", "issues", issues.find((n) => n.includes("e1aaa"))!),
    "utf8",
  );
  assert.match(tier1Body, /<!-- lbvd:fp:e1aaaaaaaaaa -->/);
});
