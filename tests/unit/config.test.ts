import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ConfigError,
  loadConfig,
  resolveAuthCredential,
} from "../../src/config/load.js";

function writeYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atcfg-"));
  const p = path.join(dir, "lbvd.yaml");
  fs.writeFileSync(p, content);
  return p;
}

test("unknown key fatal", () => {
  const p = writeYaml("nope: 1\n");
  assert.throws(
    () => loadConfig({ configPath: p, flags: { dryRun: true }, env: {} }),
    (e: unknown) => e instanceof ConfigError && /unknown key/.test((e as ConfigError).message),
  );
});

test("CLI flag overrides file value", () => {
  const p = writeYaml("concurrency: 8\noutput:\n  mode: local\n");
  const cfg = loadConfig({
    configPath: p,
    flags: { concurrency: 1, dryRun: true },
    env: {},
  });
  assert.equal(cfg.concurrency, 1);
});

test("dry-run skips token check", () => {
  const p = writeYaml("output:\n  mode: vcs\nvcs:\n  repo: o/r\n");
  const cfg = loadConfig({ configPath: p, flags: { dryRun: true }, env: {} });
  assert.equal(cfg.vcs.repo, "o/r");
});

test("non-dry-run requires token in vcs mode", () => {
  const p = writeYaml("output:\n  mode: vcs\nvcs:\n  repo: o/r\n");
  assert.throws(
    () => loadConfig({ configPath: p, flags: {}, env: {} }),
    (e: unknown) => e instanceof ConfigError && /GITHUB_TOKEN|source_token_env/.test((e as ConfigError).message),
  );
});

test("auth.mode defaults to api_key when omitted", () => {
  const p = writeYaml("output:\n  mode: local\n");
  const cfg = loadConfig({ configPath: p, flags: { dryRun: true }, env: {} });
  assert.equal(cfg.auth.mode, "api_key");
});

test("auth.mode reads from file", () => {
  const p = writeYaml("output:\n  mode: local\nauth:\n  mode: subscription\n");
  const cfg = loadConfig({ configPath: p, flags: { dryRun: true }, env: {} });
  assert.equal(cfg.auth.mode, "subscription");
});

test("invalid auth.mode value rejected", () => {
  const p = writeYaml("output:\n  mode: local\nauth:\n  mode: oauth\n");
  assert.throws(
    () => loadConfig({ configPath: p, flags: { dryRun: true }, env: {} }),
    (e: unknown) =>
      e instanceof ConfigError && /auth\.mode must be one of/.test((e as ConfigError).message),
  );
});

test("LBVD_AUTH_MODE env overrides file value", () => {
  const p = writeYaml("output:\n  mode: local\nauth:\n  mode: api_key\n");
  const cfg = loadConfig({
    configPath: p,
    flags: { dryRun: true },
    env: { LBVD_AUTH_MODE: "subscription" },
  });
  assert.equal(cfg.auth.mode, "subscription");
});

test("invalid LBVD_AUTH_MODE env rejected with named-var message", () => {
  const p = writeYaml("output:\n  mode: local\n");
  assert.throws(
    () =>
      loadConfig({
        configPath: p,
        flags: { dryRun: true },
        env: { LBVD_AUTH_MODE: "garbage" },
      }),
    (e: unknown) =>
      e instanceof ConfigError && /LBVD_AUTH_MODE/.test((e as ConfigError).message),
  );
});

test("--auth-mode CLI flag wins over LBVD_AUTH_MODE and file", () => {
  const p = writeYaml("output:\n  mode: local\nauth:\n  mode: api_key\n");
  const cfg = loadConfig({
    configPath: p,
    flags: { dryRun: true, authMode: "subscription" },
    env: { LBVD_AUTH_MODE: "api_key" },
  });
  assert.equal(cfg.auth.mode, "subscription");
});

test("resolveAuthCredential returns ANTHROPIC_API_KEY in api_key mode", () => {
  const p = writeYaml("output:\n  mode: local\nauth:\n  mode: api_key\n");
  const cfg = loadConfig({ configPath: p, flags: { dryRun: true }, env: {} });
  const cred = resolveAuthCredential(cfg, { ANTHROPIC_API_KEY: "sk-ant-aaa" });
  assert.equal(cred.envVarName, "ANTHROPIC_API_KEY");
  assert.equal(cred.tokenValue, "sk-ant-aaa");
});

test("resolveAuthCredential returns CLAUDE_CODE_OAUTH_TOKEN in subscription mode", () => {
  const p = writeYaml("output:\n  mode: local\nauth:\n  mode: subscription\n");
  const cfg = loadConfig({ configPath: p, flags: { dryRun: true }, env: {} });
  const cred = resolveAuthCredential(cfg, { CLAUDE_CODE_OAUTH_TOKEN: "oat_abc12345" });
  assert.equal(cred.envVarName, "CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(cred.tokenValue, "oat_abc12345");
});

test("resolveAuthCredential missing env aborts with helpful message", () => {
  const p = writeYaml("output:\n  mode: local\nauth:\n  mode: subscription\n");
  const cfg = loadConfig({ configPath: p, flags: { dryRun: true }, env: {} });
  assert.throws(
    () => resolveAuthCredential(cfg, {}),
    (e: unknown) =>
      e instanceof ConfigError &&
      /CLAUDE_CODE_OAUTH_TOKEN is unset/.test((e as ConfigError).message) &&
      /claude setup-token/.test((e as ConfigError).message),
  );
});

test("resolveAuthCredential blank value aborts", () => {
  const p = writeYaml("output:\n  mode: local\nauth:\n  mode: api_key\n");
  const cfg = loadConfig({ configPath: p, flags: { dryRun: true }, env: {} });
  assert.throws(
    () => resolveAuthCredential(cfg, { ANTHROPIC_API_KEY: "   " }),
    (e: unknown) =>
      e instanceof ConfigError && /is set but blank/.test((e as ConfigError).message),
  );
});

test("auth.mode reaches state snapshot via config (round-trip)", () => {
  const p = writeYaml("output:\n  mode: local\nauth:\n  mode: subscription\n");
  const cfg = loadConfig({ configPath: p, flags: { dryRun: true }, env: {} });
  // The dispatcher will JSON-serialize the config into state.config_snapshot;
  // verify the auth subtree survives a round-trip.
  const roundTrip = JSON.parse(JSON.stringify(cfg)) as typeof cfg;
  assert.equal(roundTrip.auth.mode, "subscription");
});
