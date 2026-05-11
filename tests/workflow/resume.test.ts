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

function fixtureRoot(): string {
  return path.join(repoRoot(), "tests", "fixtures", "canned-agents");
}

function tsxBin(): string {
  return path.join(repoRoot(), "node_modules", ".bin", "tsx");
}

function makePlantedRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atresume-"));
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

test("resume after artificially marking a target stage1_running clears _pending and rewrites it", () => {
  const root = makePlantedRepo();
  const env = {
    ...process.env,
    LBVD_RUNNER: "fixture",
    LBVD_FIXTURE_SCENARIO: "baseline",
    LBVD_FIXTURE_ROOT: fixtureRoot(),
  };
  const cli = path.join(repoRoot(), "src", "cli.ts");
  const r1 = spawnSync(tsxBin(), [cli, "scan-all", "--config", "lbvd.yaml", "--run-id", "20260509T120100Z-cafef00d"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(r1.status, 0, `stderr1: ${r1.stderr}`);

  const stateFile = path.join(root, ".lbvd", "20260509T120100Z-cafef00d", "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  // Force eval.js back to queued and remove its results, simulating a crash before stage 2.
  state.targets["eval.js"].state = "stage1_running";
  state.targets["eval.js"].fingerprint = null;
  state.targets["eval.js"].branch_url = null;
  state.targets["eval.js"].issue_url = null;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  // Remove the output artifacts from this target's subtree
  fs.rmSync(path.join(root, ".lbvd", "20260509T120100Z-cafef00d", "targets", "e1aaaaaaaaaa"), {
    recursive: true,
    force: true,
  });
  // Also remove the per-target finding/issue from the local report
  fs.rmSync(path.join(root, ".lbvd", "20260509T120100Z-cafef00d", "local-report"), {
    recursive: true,
    force: true,
  });

  const r2 = spawnSync(tsxBin(), [cli, "resume", "20260509T120100Z-cafef00d"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(r2.status, 0, `stderr2: ${r2.stderr}`);

  const after = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(after.targets["eval.js"].state, "done", `final state was ${after.targets["eval.js"].state}`);
});
