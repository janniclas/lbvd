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

test("scan-changes --dry-run with empty staged set", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atdry-"));
  gitInit(root);
  fs.writeFileSync(path.join(root, "x.js"), "console.log(1);");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  const tsxBin = path.join(repoRoot(), "node_modules", ".bin", "tsx");
  const result = spawnSync(
    tsxBin,
    [path.join(repoRoot(), "src", "cli.ts"), "scan-changes", "--dry-run"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /0 targets/);
  assert.ok(!fs.existsSync(path.join(root, ".lbvd")), "no run dir created on dry-run");
});

test("scan-all --dry-run prints target list", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atdry-"));
  gitInit(root);
  fs.writeFileSync(path.join(root, "a.js"), "1;");
  fs.writeFileSync(path.join(root, "b.js"), "2;");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  const tsxBin = path.join(repoRoot(), "node_modules", ".bin", "tsx");
  const result = spawnSync(
    tsxBin,
    [path.join(repoRoot(), "src", "cli.ts"), "scan-all", "--dry-run"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("a.js"));
  assert.ok(result.stdout.includes("b.js"));
});
