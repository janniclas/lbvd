import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decideToolUse, type ShimGate } from "../../src/runner/sdk-tool-shim.js";

function makeGate(overrides: Partial<ShimGate> = {}): ShimGate {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atshim-r-")));
  const targetSubtree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atshim-t-")));
  fs.writeFileSync(path.join(repoRoot, "src.js"), "1;\n");
  return {
    caps: ["fs:read"],
    repoRoot,
    targetSubtree,
    targetFile: "src.js",
    scanScope: "hint+verify",
    ...overrides,
  };
}

test("Stage-1: Read denied without fs:read", () => {
  const gate = makeGate({ caps: [] });
  const d = decideToolUse("Read", { file_path: path.join(gate.repoRoot, "src.js") }, gate);
  assert.equal(d.behavior, "deny");
});

test("Stage-1: Read allowed for in-repo file", () => {
  const gate = makeGate();
  const d = decideToolUse("Read", { file_path: path.join(gate.repoRoot, "src.js") }, gate);
  assert.equal(d.behavior, "allow");
});

test("Stage-1: Read denied for absolute path outside repo and subtree", () => {
  const gate = makeGate();
  const d = decideToolUse("Read", { file_path: "/etc/passwd" }, gate);
  assert.equal(d.behavior, "deny");
});

test("hint_only: Read denied for any file other than the hinted target", () => {
  const gate = makeGate({ scanScope: "hint_only" });
  fs.writeFileSync(path.join(gate.repoRoot, "other.js"), "x;\n");
  const d = decideToolUse("Read", { file_path: path.join(gate.repoRoot, "other.js") }, gate);
  assert.equal(d.behavior, "deny");
});

test("hint_only: Read allowed for the hinted target", () => {
  const gate = makeGate({ scanScope: "hint_only" });
  const d = decideToolUse("Read", { file_path: path.join(gate.repoRoot, "src.js") }, gate);
  assert.equal(d.behavior, "allow");
});

test("Stage-1: Bash denied (no shell capability)", () => {
  const gate = makeGate();
  const d = decideToolUse("Bash", { command: "ls" }, gate);
  assert.equal(d.behavior, "deny");
});

test("Stage-2: Bash allowed when shell granted", () => {
  const gate = makeGate({ caps: ["fs:read", "fs:write", "shell"] });
  const d = decideToolUse("Bash", { command: "ls" }, gate);
  assert.equal(d.behavior, "allow");
});

test("Stage-2: Write outside targetSubtree is denied", () => {
  const gate = makeGate({ caps: ["fs:read", "fs:write", "fs:write:targetSubtree"] });
  const d = decideToolUse(
    "Write",
    { file_path: path.join(gate.repoRoot, "evil.txt") },
    gate,
  );
  assert.equal(d.behavior, "deny");
});

test("Stage-2: Write inside targetSubtree is allowed", () => {
  const gate = makeGate({ caps: ["fs:read", "fs:write", "fs:write:targetSubtree"] });
  const d = decideToolUse(
    "Write",
    { file_path: path.join(gate.targetSubtree, "outcome.json") },
    gate,
  );
  assert.equal(d.behavior, "allow");
});

test("Stage-1: Write denied without fs:write* capability (fs:read alone is not sufficient)", () => {
  const gate = makeGate({ caps: ["fs:read"] });
  const d = decideToolUse(
    "Write",
    { file_path: path.join(gate.targetSubtree, "finding.json") },
    gate,
  );
  assert.equal(d.behavior, "deny");
});

test("Stage-1: Write to finding.json allowed via fs:write:targetSubtree carve-out", () => {
  const gate = makeGate({ caps: ["fs:read", "fs:write:targetSubtree"] });
  const d = decideToolUse(
    "Write",
    { file_path: path.join(gate.targetSubtree, "finding.json") },
    gate,
  );
  assert.equal(d.behavior, "allow");
});

test("Stage-2: WebFetch denied without net capability", () => {
  const gate = makeGate({ caps: ["fs:read", "fs:write", "shell"] });
  const d = decideToolUse("WebFetch", { url: "https://example.com" }, gate);
  assert.equal(d.behavior, "deny");
});

test("Stage-2: WebFetch allowed with net capability", () => {
  const gate = makeGate({ caps: ["fs:read", "fs:write", "shell", "net"] });
  const d = decideToolUse("WebFetch", { url: "https://example.com" }, gate);
  assert.equal(d.behavior, "allow");
});

test("Unknown tool denied by default", () => {
  const gate = makeGate({ caps: ["fs:read", "fs:write", "shell", "net"] });
  const d = decideToolUse("MysteryTool", {}, gate);
  assert.equal(d.behavior, "deny");
});

test("Agent / Task tools denied even with all caps", () => {
  const gate = makeGate({ caps: ["fs:read", "fs:write", "shell", "net"] });
  for (const t of ["Agent", "Task", "TaskCreate"]) {
    const d = decideToolUse(t, {}, gate);
    assert.equal(d.behavior, "deny", `${t} must be denied`);
  }
});

test("Path-traversal write attempt denied", () => {
  const gate = makeGate({ caps: ["fs:read", "fs:write", "fs:write:targetSubtree"] });
  const d = decideToolUse(
    "Write",
    { file_path: path.join(gate.targetSubtree, "..", "..", "etc", "passwd") },
    gate,
  );
  assert.equal(d.behavior, "deny");
});

// --- C1 relative-path bypass coverage ---

test("Read: relative '../../etc/passwd' denied in hint+verify scope", () => {
  const gate = makeGate({ scanScope: "hint+verify" });
  const d = decideToolUse("Read", { file_path: "../../../../etc/passwd" }, gate);
  assert.equal(d.behavior, "deny");
});

test("Read: relative '../../etc/passwd' denied in repo_wide scope", () => {
  const gate = makeGate({ scanScope: "repo_wide" });
  const d = decideToolUse("Read", { file_path: "../../../../etc/passwd" }, gate);
  assert.equal(d.behavior, "deny");
});

test("Glob: relative '../../**/*' denied", () => {
  const gate = makeGate({ scanScope: "hint+verify" });
  const d = decideToolUse("Glob", { path: "../../**/*" }, gate);
  assert.equal(d.behavior, "deny");
});

test("Grep: relative path '..' denied", () => {
  const gate = makeGate({ scanScope: "hint+verify" });
  const d = decideToolUse("Grep", { pattern: "secret", path: "../../etc" }, gate);
  assert.equal(d.behavior, "deny");
});

test("Grep with no path is allowed (cwd-bound by SDK; pattern is regex, not path)", () => {
  const gate = makeGate({ scanScope: "hint+verify" });
  const d = decideToolUse("Grep", { pattern: "secret" }, gate);
  assert.equal(d.behavior, "allow");
});

test("Glob: bare wildcard '*' denied (no literal prefix)", () => {
  const gate = makeGate({ scanScope: "hint+verify" });
  const d = decideToolUse("Glob", { path: "*" }, gate);
  assert.equal(d.behavior, "deny");
});

test("Glob: bare '?' denied (no literal prefix)", () => {
  const gate = makeGate({ scanScope: "hint+verify" });
  const d = decideToolUse("Glob", { path: "?" }, gate);
  assert.equal(d.behavior, "deny");
});

test("Read: relative path with '..' segment denied via traversal check", () => {
  // Explicit '..' segment (not just resolution past root) is rejected by
  // confineToParent's input-rejection.
  const gate = makeGate({ scanScope: "repo_wide" });
  const d = decideToolUse("Read", { file_path: "subdir/../escape" }, gate);
  assert.equal(d.behavior, "deny");
});

test("TaskUpdate (deny-list completeness)", () => {
  const gate = makeGate({ caps: ["fs:read", "fs:write", "fs:write:targetSubtree", "shell", "net"] });
  const d = decideToolUse("TaskUpdate", {}, gate);
  assert.equal(d.behavior, "deny");
});
