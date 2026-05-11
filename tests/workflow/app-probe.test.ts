import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atprobe-"));
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

function runScan(root: string, scenario: string, runId: string): ReturnType<typeof spawnSync> {
  const cli = path.join(repoRoot(), "src", "cli.ts");
  return spawnSync(
    tsxBin(),
    [cli, "scan-all", "--config", "lbvd.yaml", "--run-id", runId],
    {
      cwd: root,
      env: {
        ...process.env,
        LBVD_RUNNER: "fixture",
        LBVD_FIXTURE_SCENARIO: scenario,
        LBVD_FIXTURE_ROOT: fixturePath(),
      },
      encoding: "utf8",
    },
  );
}

interface LogLine {
  level: string;
  event: string;
  [k: string]: unknown;
}

function findEvent(stdout: unknown, event: string): LogLine | null {
  const text = typeof stdout === "string" ? stdout : String(stdout ?? "");
  for (const line of text.split("\n")) {
    if (!line.includes(`"event":"${event}"`)) continue;
    try {
      const parsed = JSON.parse(line) as LogLine;
      if (parsed.event === event) return parsed;
    } catch {
      /* not a JSON line */
    }
  }
  return null;
}

test("probe.start and probe.done events reach stdout (non-TTY user feedback)", () => {
  const root = makePlantedRepo();
  const RUN_ID = "20260511T120030Z-bbbbbbb1";
  const r = runScan(root, "probe-startable", RUN_ID);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const start = findEvent(r.stdout, "probe.start");
  assert.ok(start !== null, `probe.start INFO line missing; stdout:\n${r.stdout}`);
  assert.equal(typeof start.budget_seconds, "number");
  const done = findEvent(r.stdout, "probe.done");
  assert.ok(done !== null, `probe.done INFO line missing; stdout:\n${r.stdout}`);
  assert.equal(done.startable, true);
  assert.equal(typeof done.wall_seconds, "number");
});

test("probe.done for not-startable carries sanitised failure_reason", () => {
  const root = makePlantedRepo();
  const RUN_ID = "20260511T120031Z-bbbbbbb2";
  const r = runScan(root, "probe-not-startable", RUN_ID);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const done = findEvent(r.stdout, "probe.done");
  assert.ok(done !== null);
  assert.equal(done.startable, false);
  assert.equal(typeof done.failure_reason, "string");
  // No raw control bytes or ANSI sequences in the logged failure_reason.
  const reason = done.failure_reason as string;
  assert.ok(!/\x1B\[/.test(reason), "failure_reason must not contain ANSI escapes");
  assert.ok(!/[\r\n]/.test(reason), "failure_reason must not contain newlines");
});

test("agent-supplied ANSI/newline in probe failure_reason is stripped before logging (sec H1)", () => {
  const root = makePlantedRepo();
  const RUN_ID = "20260511T120032Z-bbbbbbb3";
  // Plant a malicious scenario in a scratch fixture root: a probe file
  // with an ANSI-escape-laden failure_reason.
  const scenarioRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atprobeansi-"));
  const scenarioDir = path.join(scenarioRoot, "evil");
  fs.mkdirSync(path.join(scenarioDir, "probe"), { recursive: true });
  fs.writeFileSync(
    path.join(scenarioDir, "probe", "app-probe.json"),
    JSON.stringify({
      schema_version: 1,
      startable: false,
      start_commands: [],
      stop_commands: [],
      port: null,
      health_check_url: null,
      startup_timeout_seconds: 0,
      pre_conditions: [],
      probe_narrative: "n/a",
      tried: false,
      successfully_started: false,
      // ANSI clear-screen + injected fake success
      failure_reason: "\x1B[2J\x1B[H[SUCCESS] hijacked",
      probe_token_usage: { input: 0, output: 0 },
      probe_wall_seconds: 0,
    }),
  );
  // No stage1 fixture; stage 1 will fail. That's fine — we only care
  // about the probe.done log line.
  const cli = path.join(repoRoot(), "src", "cli.ts");
  const r = spawnSync(
    tsxBin(),
    [cli, "scan-all", "--config", "lbvd.yaml", "--run-id", RUN_ID],
    {
      cwd: root,
      env: {
        ...process.env,
        LBVD_RUNNER: "fixture",
        LBVD_FIXTURE_SCENARIO: "evil",
        LBVD_FIXTURE_ROOT: scenarioRoot,
      },
      encoding: "utf8",
    },
  );
  void r;
  const done = findEvent(r.stdout, "probe.done");
  assert.ok(done !== null, `probe.done missing; stdout:\n${r.stdout}`);
  const reason = done.failure_reason as string;
  assert.ok(!/\x1B/.test(reason), `ANSI bytes leaked into log: ${JSON.stringify(reason)}`);
  // The injected text after ANSI bytes is left alone (visible to operator
  // but no longer wrapped in escape codes that could rewrite the terminal).
  assert.ok(reason.includes("hijacked"), "redacted reason should still preserve the printable suffix");
});

test("probe startable: app-probe.json produced and Stage 2 outcome stays Tier 1", () => {
  const root = makePlantedRepo();
  const RUN_ID = "20260511T120000Z-aaaaaaa1";
  const r = runScan(root, "probe-startable", RUN_ID);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const runDir = path.join(root, ".lbvd", RUN_ID);

  // Dispatcher-zone app-probe.json must exist with startable: true.
  const probePath = path.join(runDir, "app-probe.json");
  assert.ok(fs.existsSync(probePath), "app-probe.json missing");
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
  assert.equal(probe.startable, true);
  assert.ok(Array.isArray(probe.start_commands) && probe.start_commands.length > 0);
  assert.ok(Array.isArray(probe.stop_commands) && probe.stop_commands.length > 0);

  // Manifest reflects probe.
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  assert.equal(manifest.app_probe.startable, true);
  assert.equal(manifest.counts_by_tier.tier1, 1, "expected one Tier 1 outcome (probe startable)");

  // State has app_probe.state = done.
  const state = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
  assert.equal(state.app_probe.state, "done");
  assert.equal(state.app_probe.startable, true);
});

test("probe not startable: Tier 1 claim is downgraded to Tier 2", () => {
  const root = makePlantedRepo();
  const RUN_ID = "20260511T120001Z-aaaaaaa2";
  const r = runScan(root, "probe-not-startable", RUN_ID);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const runDir = path.join(root, ".lbvd", RUN_ID);

  const probe = JSON.parse(fs.readFileSync(path.join(runDir, "app-probe.json"), "utf8"));
  assert.equal(probe.startable, false);

  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  assert.equal(manifest.app_probe.startable, false);
  assert.equal(manifest.counts_by_tier.tier1, 0);
  assert.equal(manifest.counts_by_tier.tier2, 1, "Tier 1 claim should downgrade to Tier 2");

  // Outcome file must record the downgrade reason.
  const fingerprint = "abcdef987654";
  const outcomePath = path.join(runDir, "targets", fingerprint, "outcome.json");
  const outcome = JSON.parse(fs.readFileSync(outcomePath, "utf8"));
  assert.equal(outcome.tier, 2);
  assert.equal(outcome.downgrade_reason, "app_not_startable");
});

test("probe absent scenario: yields startable:false with failure_reason", () => {
  // The fixture-probe-host writes a synthesized startable:false record
  // whenever the scenario directory has no probe/app-probe.json file.
  // Use a configured-but-empty scenario directory so the run actually
  // completes (the no-such-scenario path would fail Stage 1 too).
  const root = makePlantedRepo();
  const RUN_ID = "20260511T120002Z-aaaaaaa3";
  const r = runScan(root, "probe-not-startable", RUN_ID);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const runDir = path.join(root, ".lbvd", RUN_ID);
  const probe = JSON.parse(fs.readFileSync(path.join(runDir, "app-probe.json"), "utf8"));
  assert.equal(probe.startable, false);
  assert.ok(typeof probe.failure_reason === "string");
  assert.ok(probe.failure_reason.length > 0);
});

test("probe wall-clock budget kill: failure_reason = 'probe_wall_clock_cap', tier1 downgraded", () => {
  // Configure app_probe_seconds=1 with a fixture probe scenario whose
  // host blocks longer than the budget. The dispatcher's probe timer
  // fires, kills the agent, and synthesises `startable: false,
  // failure_reason: "probe_wall_clock_cap"`. Stage 2 outcomes then
  // downgrade Tier 1 → Tier 2 (F7.21 acceptance).
  const root = makePlantedRepo();
  const RUN_ID = "20260511T120010Z-aaaaaab1";
  fs.writeFileSync(
    path.join(root, "lbvd.yaml"),
    [
      "concurrency: 1",
      "output:",
      "  mode: local",
      "runner:",
      "  kind: fixture",
      "budgets:",
      "  app_probe_seconds: 1",
      "",
    ].join("\n"),
  );
  const r = runScan(root, "probe-slow", RUN_ID);
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  const runDir = path.join(root, ".lbvd", RUN_ID);
  const probe = JSON.parse(fs.readFileSync(path.join(runDir, "app-probe.json"), "utf8"));
  assert.equal(probe.startable, false);
  assert.equal(probe.failure_reason, "probe_wall_clock_cap");
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  assert.equal(manifest.app_probe.startable, false);
  assert.equal(manifest.counts_by_tier.tier1, 0, "Tier 1 outcomes must be downgraded when probe budget killed");
});

test("resume after probe done: spawnProbe is NOT re-invoked", () => {
  const root = makePlantedRepo();
  const RUN_ID = "20260511T120003Z-aaaaaaa4";
  const r1 = runScan(root, "probe-startable", RUN_ID);
  assert.equal(r1.status, 0, `stderr1: ${r1.stderr}`);
  const runDir = path.join(root, ".lbvd", RUN_ID);

  const stateBefore = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
  assert.equal(stateBefore.app_probe.state, "done");
  const probeMtime = fs.statSync(path.join(runDir, "app-probe.json")).mtimeMs;

  // Resume the same run-id. Since app_probe state is `done` and the
  // dispatcher-zone file is present, the probe is reused.
  const cli = path.join(repoRoot(), "src", "cli.ts");
  const r2 = spawnSync(tsxBin(), [cli, "resume", RUN_ID], {
    cwd: root,
    env: {
      ...process.env,
      LBVD_RUNNER: "fixture",
      LBVD_FIXTURE_SCENARIO: "probe-startable",
      LBVD_FIXTURE_ROOT: fixturePath(),
    },
    encoding: "utf8",
  });
  assert.equal(r2.status, 0, `stderr2: ${r2.stderr}`);
  const probeMtimeAfter = fs.statSync(path.join(runDir, "app-probe.json")).mtimeMs;
  assert.equal(probeMtimeAfter, probeMtime, "app-probe.json must not be rewritten on resume when probe state is done");
});

test(
  "SIGINT during probe phase: user_interrupt termination + manifest + exit 6 (FR-17/H2)",
  { timeout: 30_000 },
  async () => {
    const root = makePlantedRepo();
    const RUN_ID = "20260511T120020Z-aaaaaab2";
    fs.writeFileSync(
      path.join(root, "lbvd.yaml"),
      [
        "concurrency: 1",
        "output:",
        "  mode: local",
        "runner:",
        "  kind: fixture",
        "budgets:",
        // generous probe budget; we kill via SIGINT before budget fires
        "  app_probe_seconds: 60",
        "",
      ].join("\n"),
    );
    const cli = path.join(repoRoot(), "src", "cli.ts");
    const proc = spawn(
      tsxBin(),
      [cli, "scan-all", "--config", "lbvd.yaml", "--run-id", RUN_ID],
      {
        cwd: root,
        env: {
          ...process.env,
          LBVD_RUNNER: "fixture",
          LBVD_FIXTURE_SCENARIO: "probe-slow",
          LBVD_FIXTURE_ROOT: fixturePath(),
        },
        stdio: "ignore",
      },
    );
    // Wait until state.json exists and app_probe.state === "running"
    const runDir = path.join(root, ".lbvd", RUN_ID);
    const stateFile = path.join(runDir, "state.json");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(stateFile)) {
        try {
          const s = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
            app_probe?: { state: string };
          };
          if (s.app_probe?.state === "running") break;
        } catch {
          /* race; retry */
        }
      }
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    proc.kill("SIGINT");
    const exitCode = await new Promise<number>((resolve) => {
      proc.on("close", (code) => resolve(code ?? 1));
    });
    assert.equal(exitCode, 6, "SIGINT during probe must exit with code 6 (FR-16)");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.terminations.length, 1, "one termination record expected");
    assert.equal(state.terminations[0]?.kind, "user_interrupt");
    assert.equal(state.terminations[0]?.signal, "SIGINT");
    assert.ok(fs.existsSync(path.join(runDir, "manifest.json")), "manifest.json must exist");
    assert.ok(fs.existsSync(path.join(runDir, "manifest.md")), "manifest.md must exist");
  },
);

test("resume after probe running: probe re-runs from scratch", () => {
  const root = makePlantedRepo();
  const RUN_ID = "20260511T120004Z-aaaaaaa5";
  const r1 = runScan(root, "probe-startable", RUN_ID);
  assert.equal(r1.status, 0, `stderr1: ${r1.stderr}`);
  const runDir = path.join(root, ".lbvd", RUN_ID);

  // Simulate a crash mid-probe: force state to `running` and remove the
  // canonical dispatcher-zone copy. Resume must re-run the probe.
  const statePath = path.join(runDir, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.app_probe = { state: "running", startable: null, completed_at: null };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  fs.rmSync(path.join(runDir, "app-probe.json"), { force: true });

  const cli = path.join(repoRoot(), "src", "cli.ts");
  const r2 = spawnSync(tsxBin(), [cli, "resume", RUN_ID], {
    cwd: root,
    env: {
      ...process.env,
      LBVD_RUNNER: "fixture",
      LBVD_FIXTURE_SCENARIO: "probe-startable",
      LBVD_FIXTURE_ROOT: fixturePath(),
    },
    encoding: "utf8",
  });
  assert.equal(r2.status, 0, `stderr2: ${r2.stderr}`);
  assert.ok(fs.existsSync(path.join(runDir, "app-probe.json")), "probe must be re-run");
  const stateAfter = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(stateAfter.app_probe.state, "done");
});
