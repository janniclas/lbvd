import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentEnv } from "../../src/runner/safe-env.js";
import { DEFAULT_CONFIG, type ResolvedConfig } from "../../src/config/defaults.js";

function withAuth(mode: "api_key" | "subscription"): ResolvedConfig {
  return { ...DEFAULT_CONFIG, auth: { mode } };
}

test("excludes forge tokens", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    GITHUB_TOKEN: "ghp_supersecret",
    GITLAB_TOKEN: "glpat-othersecret",
    MY_TOKEN: "secret",
  };
  const out = buildAgentEnv({ config: DEFAULT_CONFIG, env });
  assert.equal(out["PATH"], "/usr/bin");
  assert.equal(out["HOME"], "/home/u");
  assert.equal(out["GITHUB_TOKEN"], undefined);
  assert.equal(out["GITLAB_TOKEN"], undefined);
  assert.equal(out["MY_TOKEN"], undefined);
});

test("respects vcs.exploit_target_token_env config key", () => {
  const env = { PATH: "/u", CUSTOM_PRIVATE_TOKEN: "xxx" };
  const cfg = {
    ...DEFAULT_CONFIG,
    vcs: { ...DEFAULT_CONFIG.vcs, exploit_target_token_env: "CUSTOM_PRIVATE_TOKEN" },
  };
  const out = buildAgentEnv({ config: cfg, env });
  assert.equal(out["CUSTOM_PRIVATE_TOKEN"], undefined);
});

test("includes LBVD_REPO_ROOT via extra", () => {
  const out = buildAgentEnv({
    config: DEFAULT_CONFIG,
    env: { PATH: "/u" },
    extra: { LBVD_REPO_ROOT: "/repo" },
  });
  assert.equal(out["LBVD_REPO_ROOT"], "/repo");
});

test("api_key mode forwards ANTHROPIC_API_KEY and drops OAuth + custom token", () => {
  const env = {
    PATH: "/u",
    ANTHROPIC_API_KEY: "sk-ant-api03-xxxxxxxxxxxx",
    CLAUDE_CODE_OAUTH_TOKEN: "oat_xxxxxxxxxxxxxxxx",
    ANTHROPIC_AUTH_TOKEN: "custom-bearer-token",
  };
  const out = buildAgentEnv({ config: withAuth("api_key"), env });
  assert.equal(out["ANTHROPIC_API_KEY"], "sk-ant-api03-xxxxxxxxxxxx");
  assert.equal(out["CLAUDE_CODE_OAUTH_TOKEN"], undefined);
  assert.equal(out["ANTHROPIC_AUTH_TOKEN"], undefined);
});

test("subscription mode forwards CLAUDE_CODE_OAUTH_TOKEN and drops api key + custom token", () => {
  const env = {
    PATH: "/u",
    ANTHROPIC_API_KEY: "sk-ant-api03-xxxxxxxxxxxx",
    CLAUDE_CODE_OAUTH_TOKEN: "oat_xxxxxxxxxxxxxxxx",
    ANTHROPIC_AUTH_TOKEN: "custom-bearer-token",
  };
  const out = buildAgentEnv({ config: withAuth("subscription"), env });
  assert.equal(out["CLAUDE_CODE_OAUTH_TOKEN"], "oat_xxxxxxxxxxxxxxxx");
  assert.equal(out["ANTHROPIC_API_KEY"], undefined);
  assert.equal(out["ANTHROPIC_AUTH_TOKEN"], undefined);
});

test("Bedrock/Vertex/AWS env vars forwarded regardless of mode", () => {
  const env = {
    PATH: "/u",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "AKIA0000",
    CLAUDE_CODE_USE_BEDROCK: "1",
    GOOGLE_APPLICATION_CREDENTIALS: "/path/to/key.json",
  };
  for (const mode of ["api_key", "subscription"] as const) {
    const out = buildAgentEnv({ config: withAuth(mode), env });
    assert.equal(out["AWS_REGION"], "us-east-1");
    assert.equal(out["AWS_ACCESS_KEY_ID"], "AKIA0000");
    assert.equal(out["CLAUDE_CODE_USE_BEDROCK"], "1");
    assert.equal(out["GOOGLE_APPLICATION_CREDENTIALS"], "/path/to/key.json");
  }
});

test("empty-string auth credential is treated as unset (api_key)", () => {
  const env = { PATH: "/u", ANTHROPIC_API_KEY: "" };
  const out = buildAgentEnv({ config: withAuth("api_key"), env });
  assert.equal(out["ANTHROPIC_API_KEY"], undefined);
});

test("empty-string auth credential is treated as unset (subscription)", () => {
  const env = { PATH: "/u", CLAUDE_CODE_OAUTH_TOKEN: "" };
  const out = buildAgentEnv({ config: withAuth("subscription"), env });
  assert.equal(out["CLAUDE_CODE_OAUTH_TOKEN"], undefined);
});
