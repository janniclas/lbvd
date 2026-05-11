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

test("output.mode=local with vcs.* keys: runs successfully (warning emitted, no network)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlocal-"));
  gitInit(root);
  fs.writeFileSync(path.join(root, "clean.js"), "1;");
  fs.writeFileSync(
    path.join(root, "lbvd.yaml"),
    [
      "output:",
      "  mode: local",
      "vcs:",
      "  provider: github",
      "  repo: someone/somerepo",
      "runner:",
      "  kind: fixture",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

  const tsxBin = path.join(repoRoot(), "node_modules", ".bin", "tsx");
  // No GITHUB_TOKEN set: local mode must accept and proceed without forge access.
  const env = { ...process.env };
  delete env["GITHUB_TOKEN"];
  delete env["GITLAB_TOKEN"];
  env["LBVD_RUNNER"] = "fixture";
  env["LBVD_FIXTURE_SCENARIO"] = "baseline";
  env["LBVD_FIXTURE_ROOT"] = path.join(repoRoot(), "tests", "fixtures", "canned-agents");

  const result = spawnSync(
    tsxBin,
    [path.join(repoRoot(), "src", "cli.ts"), "scan-all", "--config", "lbvd.yaml", "--run-id", "20260509T120500Z-1234abcd"],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /vcs\.\* keys are ignored/);
});
