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

test("web-sandbox preflight refuses oversized run with exit 2", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atpf-"));
  gitInit(root);
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(path.join(root, `f${i}.js`), `// ${i}\n`);
  }
  fs.writeFileSync(
    path.join(root, "lbvd.yaml"),
    [
      "concurrency: 1",
      "output:",
      "  mode: local",
      "runner:",
      "  kind: fixture",
      "preflight:",
      "  enabled_on_substrate: web-sandbox",
      "  max_targets: 3",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

  const tsxBin = path.join(repoRoot(), "node_modules", ".bin", "tsx");
  const result = spawnSync(
    tsxBin,
    [path.join(repoRoot(), "src", "cli.ts"), "scan-all", "--config", "lbvd.yaml"],
    {
      cwd: root,
      env: {
        ...process.env,
        LBVD_SUBSTRATE: "web-sandbox",
        LBVD_RUNNER: "fixture",
        LBVD_FIXTURE_SCENARIO: "baseline",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 2, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /preflight/);
});
