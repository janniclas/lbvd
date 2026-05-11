import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

function repoRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

function tsxBin(): string {
  return path.join(repoRoot(), "node_modules", ".bin", "tsx");
}

function fixturePath(): string {
  return path.join(repoRoot(), "tests", "fixtures", "canned-agents");
}

function makePlantedRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atsig-"));
  gitInit(root);
  // 6 targets: a–c complete quickly, d hangs, e–f queued then resumed
  for (const name of ["a.js", "b.js", "c.js", "d.js", "e.js", "f.js"]) {
    fs.writeFileSync(path.join(root, name), `// ${name}\n`);
  }
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

function waitForExit(proc: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    proc.on("close", (code) => resolve(code ?? 1));
  });
}

const RUN_ID = "20260511T120000Z-deadf00d";

test(
  "signal shutdown: SIGINT writes manifest with user_interrupt termination, resume completes",
  { timeout: 60_000 },
  async () => {
    const root = makePlantedRepo();
    const cli = path.join(repoRoot(), "src", "cli.ts");
    const env = {
      ...process.env,
      LBVD_RUNNER: "fixture",
      LBVD_FIXTURE_SCENARIO: "signal-shutdown",
      LBVD_FIXTURE_ROOT: fixturePath(),
    };

    // --- Phase 1: scan-all, interrupt mid-run ---
    const proc = spawn(
      tsxBin(),
      [cli, "scan-all", "--config", "lbvd.yaml", "--run-id", RUN_ID],
      { cwd: root, env, stdio: "ignore" },
    );

    // Poll state.json until a.js, b.js, c.js are all in terminal states.
    // This ensures setupSignalHandlers is active and d.js is in-flight before SIGINT.
    const runDir = path.join(root, ".lbvd", RUN_ID);
    const stateFile = path.join(runDir, "state.json");
    const terminal = new Set(["done", "failed", "no_finding", "skipped_dup"]);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(stateFile)) {
        const s = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
          targets: Record<string, { state: string }>;
        };
        if (
          terminal.has(s.targets["a.js"]?.state ?? "") &&
          terminal.has(s.targets["b.js"]?.state ?? "") &&
          terminal.has(s.targets["c.js"]?.state ?? "")
        ) {
          break;
        }
      }
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    proc.kill("SIGINT");

    const exitCode = await waitForExit(proc);
    assert.equal(exitCode, 6, "expected exit code 6 for signal-interrupted run");

    // State assertions
    const state = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8")) as {
      targets: Record<string, { state: string; issue_url: string | null }>;
      terminations: { kind: string; signal?: string }[];
    };

    assert.equal(state.terminations.length, 1, "expected one termination record");
    assert.equal(state.terminations[0]?.kind, "user_interrupt");
    assert.equal(state.terminations[0]?.signal, "SIGINT");

    assert.equal(state.targets["a.js"]?.state, "done", "a.js should be done");
    assert.notEqual(state.targets["a.js"]?.issue_url, null, "a.js should have issue_url");
    assert.equal(state.targets["b.js"]?.state, "done", "b.js should be done");
    assert.notEqual(state.targets["b.js"]?.issue_url, null, "b.js should have issue_url");
    assert.equal(state.targets["c.js"]?.state, "done", "c.js should be done");
    assert.notEqual(state.targets["c.js"]?.issue_url, null, "c.js should have issue_url");

    // e.js and f.js were never dispatched — must be queued
    assert.equal(state.targets["e.js"]?.state, "queued", "e.js should be queued");
    assert.equal(state.targets["f.js"]?.state, "queued", "f.js should be queued");

    // Both manifest files must exist
    assert.ok(fs.existsSync(path.join(runDir, "manifest.json")), "manifest.json must exist");
    assert.ok(fs.existsSync(path.join(runDir, "manifest.md")), "manifest.md must exist");

    const manifest = JSON.parse(
      fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"),
    ) as { terminations: { kind: string; signal?: string }[] };
    assert.equal(manifest.terminations[0]?.kind, "user_interrupt");
    assert.equal(manifest.terminations[0]?.signal, "SIGINT");

    const manifestMd = fs.readFileSync(path.join(runDir, "manifest.md"), "utf8");
    assert.match(manifestMd, /user_interrupt \(SIGINT\)/, "manifest.md includes signal name");

    // --- Phase 2: resume should complete e.js and f.js ---
    const r2 = spawn(tsxBin(), [cli, "resume", RUN_ID], {
      cwd: root,
      env,
      stdio: "ignore",
    });
    const resumeCode = await waitForExit(r2);
    assert.equal(resumeCode, 0, "resume should exit 0");

    const after = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8")) as {
      targets: Record<string, { state: string }>;
    };
    for (const [name, t] of Object.entries(after.targets)) {
      const terminal = ["done", "failed", "no_finding", "skipped_dup"];
      assert.ok(terminal.includes(t.state), `${name} should be terminal after resume, got ${t.state}`);
    }
  },
);
