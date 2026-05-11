import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";

// Token literals used in these tests must be ≥ 8 chars so makeRedactor keeps
// them (literals shorter than 8 chars are dropped silently — see §5.2).
const FAKE_OAUTH = "oat_unit-test-fake-token-zzz1234567890";
const FAKE_API_KEY = "sk-ant-api03-unit-test-zzz1234567890";

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

function makePlantedRepo(authMode: "api_key" | "subscription"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atauth-"));
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
      "auth:",
      `  mode: ${authMode}`,
      "",
    ].join("\n"),
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return root;
}

function cleanAuthEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  delete out.ANTHROPIC_API_KEY;
  delete out.CLAUDE_CODE_OAUTH_TOKEN;
  delete out.ANTHROPIC_AUTH_TOKEN;
  delete out.LBVD_AUTH_MODE;
  for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}

function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(tsxBin(), [path.join(repoRoot(), "src", "cli.ts"), ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

function findLiteralUnderDir(dir: string, literal: string): string[] {
  const hits: string[] = [];
  for (const file of walkFiles(dir)) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (content.includes(literal)) hits.push(file);
  }
  return hits;
}

test("subscription mode: full run-dir literal sweep finds zero hits for OAuth token", () => {
  const root = makePlantedRepo("subscription");
  const env = cleanAuthEnv({
    CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH,
    LBVD_RUNNER: "fixture",
    LBVD_FIXTURE_SCENARIO: "baseline",
    LBVD_FIXTURE_ROOT: fixtureRoot(),
  });
  const runId = "20260510T120000Z-cafef001";
  const result = runCli(
    root,
    ["scan-all", "--config", "lbvd.yaml", "--run-id", runId],
    env,
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);

  const runDir = path.join(root, ".lbvd", runId);
  // The token must not appear in any file under the run dir (log, manifest,
  // config snapshot, per-target transcripts). FR-15 / §15.4 / §20.6.
  const hits = findLiteralUnderDir(runDir, FAKE_OAUTH);
  assert.deepEqual(hits, [], `OAuth literal leaked into: ${hits.join(", ")}`);
});

test("api_key mode: full run-dir literal sweep finds zero hits for ANTHROPIC_API_KEY", () => {
  const root = makePlantedRepo("api_key");
  const env = cleanAuthEnv({
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    LBVD_RUNNER: "fixture",
    LBVD_FIXTURE_SCENARIO: "baseline",
    LBVD_FIXTURE_ROOT: fixtureRoot(),
  });
  const runId = "20260510T120010Z-cafef002";
  const result = runCli(
    root,
    ["scan-all", "--config", "lbvd.yaml", "--run-id", runId],
    env,
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);

  const runDir = path.join(root, ".lbvd", runId);
  const hits = findLiteralUnderDir(runDir, FAKE_API_KEY);
  assert.deepEqual(hits, [], `API key literal leaked into: ${hits.join(", ")}`);
});

test("resume with mismatched --auth-mode exits 3 with auth-mode mismatch", () => {
  const root = makePlantedRepo("api_key");
  const runId = "20260510T120020Z-cafef003";
  const baseEnv = cleanAuthEnv({
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    LBVD_RUNNER: "fixture",
    LBVD_FIXTURE_SCENARIO: "baseline",
    LBVD_FIXTURE_ROOT: fixtureRoot(),
  });
  const r1 = runCli(
    root,
    ["scan-all", "--config", "lbvd.yaml", "--run-id", runId],
    baseEnv,
  );
  assert.equal(r1.status, 0, `stderr1: ${r1.stderr}`);

  const resumeEnv = cleanAuthEnv({
    CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH,
    LBVD_RUNNER: "fixture",
    LBVD_FIXTURE_SCENARIO: "baseline",
    LBVD_FIXTURE_ROOT: fixtureRoot(),
  });
  const r2 = runCli(
    root,
    ["resume", runId, "--auth-mode", "subscription"],
    resumeEnv,
  );
  assert.equal(r2.status, 3, `expected exit 3; got ${r2.status}; stderr: ${r2.stderr}`);
  assert.match(r2.stderr, /auth-mode mismatch/);
});

test("resume with absent-snapshot auth (pre-F5) treats snapshot as api_key", () => {
  const root = makePlantedRepo("api_key");
  const runId = "20260510T120030Z-cafef004";
  const baseEnv = cleanAuthEnv({
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    LBVD_RUNNER: "fixture",
    LBVD_FIXTURE_SCENARIO: "baseline",
    LBVD_FIXTURE_ROOT: fixtureRoot(),
  });
  const r1 = runCli(
    root,
    ["scan-all", "--config", "lbvd.yaml", "--run-id", runId],
    baseEnv,
  );
  assert.equal(r1.status, 0, `stderr1: ${r1.stderr}`);

  // Simulate a pre-F5 state.json by removing the auth subtree from the snapshot.
  const stateFile = path.join(root, ".lbvd", runId, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { config_snapshot: { auth?: unknown } };
  delete state.config_snapshot.auth;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  // Resume with api_key (no --auth-mode flag) should succeed (snapshot defaults to api_key).
  const r2 = runCli(root, ["resume", runId], baseEnv);
  assert.equal(r2.status, 0, `expected exit 0; got ${r2.status}; stderr: ${r2.stderr}`);

  // Resume with subscription mode should hit the mismatch even though snapshot is absent.
  const subEnv = cleanAuthEnv({
    CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH,
    LBVD_RUNNER: "fixture",
    LBVD_FIXTURE_SCENARIO: "baseline",
    LBVD_FIXTURE_ROOT: fixtureRoot(),
  });
  const r3 = runCli(root, ["resume", runId, "--auth-mode", "subscription"], subEnv);
  assert.equal(r3.status, 3, `expected exit 3; got ${r3.status}; stderr: ${r3.stderr}`);
  assert.match(r3.stderr, /auth-mode mismatch/);
});

// NOTE: on a new run the dispatcher calls setupNewRun (which writes state.json
// + config.snapshot.yaml + active.json + initial target dirs) *before* the
// substrate preflight gate runs. So a refused web-sandbox + api_key run
// leaves a partial run dir on the temp tree — by design, not a leak. Cleanup
// happens with tmpdir GC. The resume path was reordered so that a refused
// resume leaves the run dir untouched (post-impl review M1).
test("web-sandbox + api_key aborts with exit 2 even when targets are small", () => {
  const root = makePlantedRepo("api_key");
  const env = cleanAuthEnv({
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    LBVD_RUNNER: "fixture",
    LBVD_FIXTURE_SCENARIO: "baseline",
    LBVD_FIXTURE_ROOT: fixtureRoot(),
    LBVD_SUBSTRATE: "web-sandbox",
  });
  const result = runCli(root, ["scan-all", "--config", "lbvd.yaml"], env);
  assert.equal(result.status, 2, `expected exit 2; got ${result.status}; stderr: ${result.stderr}`);
  assert.match(result.stderr, /web sandbox requires auth\.mode: subscription/i);
});

test("web-sandbox + subscription passes the auth-mode gate", () => {
  const root = makePlantedRepo("subscription");
  const env = cleanAuthEnv({
    CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH,
    LBVD_RUNNER: "fixture",
    LBVD_FIXTURE_SCENARIO: "baseline",
    LBVD_FIXTURE_ROOT: fixtureRoot(),
    LBVD_SUBSTRATE: "web-sandbox",
  });
  const result = runCli(root, ["scan-all", "--config", "lbvd.yaml"], env);
  assert.equal(result.status, 0, `expected exit 0; got ${result.status}; stderr: ${result.stderr}`);
});

test("resume under same mode with a rotated token value is accepted", () => {
  const root = makePlantedRepo("subscription");
  const runId = "20260510T120040Z-cafef005";
  const env1 = cleanAuthEnv({
    CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH,
    LBVD_RUNNER: "fixture",
    LBVD_FIXTURE_SCENARIO: "baseline",
    LBVD_FIXTURE_ROOT: fixtureRoot(),
  });
  const r1 = runCli(
    root,
    ["scan-all", "--config", "lbvd.yaml", "--run-id", runId],
    env1,
  );
  assert.equal(r1.status, 0, `stderr1: ${r1.stderr}`);

  // Rotate the token value (same mode). FR-15: only the *mode* is snapshot-pinned.
  const env2 = cleanAuthEnv({
    CLAUDE_CODE_OAUTH_TOKEN: `${FAKE_OAUTH}-rotated-1234567890`,
    LBVD_RUNNER: "fixture",
    LBVD_FIXTURE_SCENARIO: "baseline",
    LBVD_FIXTURE_ROOT: fixtureRoot(),
  });
  const r2 = runCli(root, ["resume", runId], env2);
  assert.equal(r2.status, 0, `expected exit 0 on token rotation; got ${r2.status}; stderr: ${r2.stderr}`);
});

test("corrupt config_snapshot.auth in state.json refuses resume with generic message", () => {
  // Sec review M2: a tampered state.json must not echo attacker-supplied content
  // into the operator-facing error message.
  const root = makePlantedRepo("api_key");
  const runId = "20260510T120050Z-cafef006";
  const env = cleanAuthEnv({
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    LBVD_RUNNER: "fixture",
    LBVD_FIXTURE_SCENARIO: "baseline",
    LBVD_FIXTURE_ROOT: fixtureRoot(),
  });
  const r1 = runCli(
    root,
    ["scan-all", "--config", "lbvd.yaml", "--run-id", runId],
    env,
  );
  assert.equal(r1.status, 0, `stderr1: ${r1.stderr}`);

  // Plant a malformed auth.mode in the snapshot.
  const stateFile = path.join(root, ".lbvd", runId, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
    config_snapshot: { auth: unknown };
  };
  const ATTACKER_CONTENT = "PWNED-by-attacker-supplied-content";
  state.config_snapshot.auth = { mode: ATTACKER_CONTENT };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const r2 = runCli(root, ["resume", runId], env);
  assert.equal(r2.status, 3, `expected exit 3; got ${r2.status}; stderr: ${r2.stderr}`);
  assert.match(r2.stderr, /config_snapshot\.auth is corrupt/);
  assert.doesNotMatch(r2.stderr, new RegExp(ATTACKER_CONTENT));
});

test("missing CLAUDE_CODE_OAUTH_TOKEN in subscription mode (SDK runner) aborts with helpful message", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atauth-miss-"));
  gitInit(root);
  fs.writeFileSync(path.join(root, "eval.js"), "eval(process.argv[2]);\n");
  fs.writeFileSync(
    path.join(root, "lbvd.yaml"),
    [
      "concurrency: 1",
      "output:",
      "  mode: local",
      "runner:",
      "  kind: sdk",
      "auth:",
      "  mode: subscription",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

  const env = cleanAuthEnv({});
  const result = runCli(root, ["scan-all", "--config", "lbvd.yaml"], env);
  assert.equal(result.status, 3, `expected exit 3; got ${result.status}; stderr: ${result.stderr}`);
  assert.match(result.stderr, /CLAUDE_CODE_OAUTH_TOKEN is unset/);
  assert.match(result.stderr, /claude setup-token/);
});
