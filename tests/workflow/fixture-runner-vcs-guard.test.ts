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

test("LBVD_RUNNER=fixture + output.mode=vcs without ALLOW guard → exit 3", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atguard-"));
  gitInit(root);
  fs.writeFileSync(path.join(root, "x.js"), "1;");
  fs.writeFileSync(
    path.join(root, "lbvd.yaml"),
    [
      "concurrency: 1",
      "output:",
      "  mode: vcs",
      "vcs:",
      "  provider: github",
      "  repo: o/r",
      "runner:",
      "  kind: fixture",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

  const tsxBin = path.join(repoRoot(), "node_modules", ".bin", "tsx");
  const result = spawnSync(
    tsxBin,
    [path.join(repoRoot(), "src", "cli.ts"), "scan-all", "--config", "lbvd.yaml", "--run-id", "20260509T120400Z-aabbccdd"],
    {
      cwd: root,
      env: {
        ...process.env,
        LBVD_RUNNER: "fixture",
        GITHUB_TOKEN: "fake-token-for-config-check",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 3, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /LBVD_ALLOW_FIXTURE_VCS/);
});
