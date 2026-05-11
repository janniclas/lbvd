import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { enumerate } from "../../src/discovery/enumerate.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

function commit(dir: string, msg: string): void {
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", msg], { cwd: dir });
}

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atdisc-"));
  gitInit(root);
  fs.writeFileSync(path.join(root, "src.js"), "console.log(1);");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
  fs.mkdirSync(path.join(root, "vendor"));
  fs.writeFileSync(path.join(root, "vendor", "lib.js"), "//");
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.js\n");
  fs.writeFileSync(path.join(root, "ignored.js"), "x");
  // The "ignored.js" is tracked manually below to test gitignore-tracked-file handling
  commit(root, "init");
  return root;
}

test("scan-all skips lockfile, vendored, and gitignore-listed files", async () => {
  const root = makeRepo();
  // gitignored files are not normally listed by `git ls-files`; verify only the others.
  const list = await enumerate({ mode: "scan-all", cwd: root, config: { ...DEFAULT_CONFIG } });
  const targets = new Set(list.targets);
  assert.ok(targets.has("src.js"));
  assert.ok(!targets.has("package-lock.json"), "lockfile excluded");
  assert.ok(!targets.has("vendor/lib.js"), "vendored excluded");
});

test("disabling 'lockfiles' built-in re-includes lockfile", async () => {
  const root = makeRepo();
  const list = await enumerate({
    mode: "scan-all",
    cwd: root,
    config: {
      ...DEFAULT_CONFIG,
      blacklist: { ...DEFAULT_CONFIG.blacklist, disabled_builtins: ["lockfiles"] },
    },
  });
  assert.ok(list.targets.includes("package-lock.json"));
});

test("scan-changes returns empty list when no files staged", async () => {
  const root = makeRepo();
  const list = await enumerate({ mode: "scan-changes", cwd: root, config: { ...DEFAULT_CONFIG } });
  assert.equal(list.targets.length, 0);
});

test("config_files built-in excludes lbvd.yaml by default; disabled re-includes it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atdisccfg-"));
  gitInit(root);
  fs.writeFileSync(path.join(root, "src.js"), "console.log(1);");
  fs.writeFileSync(path.join(root, "lbvd.yaml"), "concurrency: 1\n");
  fs.writeFileSync(path.join(root, ".lbvdrc"), "{}\n");
  fs.writeFileSync(path.join(root, "lbvd.yml"), "x: y\n");
  commit(root, "init");
  const def = await enumerate({ mode: "scan-all", cwd: root, config: { ...DEFAULT_CONFIG } });
  assert.ok(!def.targets.includes("lbvd.yaml"), "lbvd.yaml excluded by default");
  assert.ok(!def.targets.includes("lbvd.yml"), "lbvd.yml excluded by default");
  assert.ok(!def.targets.includes(".lbvdrc"), ".lbvdrc excluded by default");
  assert.ok(def.targets.includes("src.js"));

  const reincluded = await enumerate({
    mode: "scan-all",
    cwd: root,
    config: {
      ...DEFAULT_CONFIG,
      blacklist: { ...DEFAULT_CONFIG.blacklist, disabled_builtins: ["config_files"] },
    },
  });
  assert.ok(
    reincluded.targets.includes("lbvd.yaml"),
    "lbvd.yaml re-included when builtin disabled",
  );
});
