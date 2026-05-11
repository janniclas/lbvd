import type { AuthMode, ResolvedConfig } from "../config/defaults.js";

const STATIC_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TERM",
  "TMPDIR",
  "NODE_VERSION",
  "NODE_OPTIONS",
  "LBVD_REPO_ROOT",
  "LBVD_RUNNER",
  "LBVD_FIXTURE_SCENARIO",
  "LBVD_FIXTURE_ROOT",
  "LBVD_SUBSTRATE",
]);

// Belt-and-braces: even though nothing in STATIC_ALLOWLIST currently matches
// this regex, the post-filter at `isStaticallyAllowed` keeps the rule in
// place so future additions to STATIC_ALLOWLIST can't silently widen the
// surface. Anthropic auth env vars get a separate, mode-gated allowlist
// below (architecture §20.2).
const TOKEN_KEY_RE = /(TOKEN|SECRET|PASSWORD|KEY|API_KEY)/i;

// Single-purpose allowlist for Anthropic SDK authentication. The TOKEN_KEY_RE
// filter would otherwise strip these. Forge tokens (vcs.source_token_env etc.)
// remain in the deny list.
const SDK_AUTH_ALLOWLIST: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUD_ML_REGION",
];

// FR-15 / architecture §20.2: Anthropic auth env vars are gated by auth.mode.
// Everything else in SDK_AUTH_ALLOWLIST (Bedrock/Vertex/cloud-provider keys) is
// forwarded unconditionally in v1; a future provider mode would graduate them.
const ANTHROPIC_AUTH_VARS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

// Per-mode forwarded subset of ANTHROPIC_AUTH_VARS. ANTHROPIC_AUTH_TOKEN is
// dropped in both v1 modes — the v1 enumeration only models the two end-user
// paths (Console key vs. subscription OAuth); custom-auth-token / gateway-proxy
// use is not a v1 use case (architecture §20.2, implementation decision log).
const MODE_AUTH_FORWARD: Record<AuthMode, ReadonlySet<string>> = {
  api_key: new Set(["ANTHROPIC_API_KEY"]),
  subscription: new Set(["CLAUDE_CODE_OAUTH_TOKEN"]),
};

interface BuildOpts {
  config: ResolvedConfig;
  env: NodeJS.ProcessEnv;
  extra?: Record<string, string>;
}

function isStaticallyAllowed(key: string): boolean {
  if (STATIC_ALLOWLIST.has(key)) return !TOKEN_KEY_RE.test(key);
  return false;
}

function isAuthVarForwarded(key: string, mode: AuthMode): boolean {
  if (!ANTHROPIC_AUTH_VARS.has(key)) return true;
  return MODE_AUTH_FORWARD[mode].has(key);
}

export function buildAgentEnv(opts: BuildOpts): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const denyList = buildDenyList(opts.config);
  for (const k of STATIC_ALLOWLIST) {
    if (!isStaticallyAllowed(k) || denyList.has(k)) continue;
    const v = opts.env[k];
    if (v !== undefined) out[k] = v;
  }
  const mode = opts.config.auth.mode;
  for (const k of SDK_AUTH_ALLOWLIST) {
    if (denyList.has(k)) continue;
    if (!isAuthVarForwarded(k, mode)) continue;
    const v = opts.env[k];
    if (v === undefined || v.length === 0) continue;
    out[k] = v;
  }
  if (opts.extra !== undefined) {
    for (const [k, v] of Object.entries(opts.extra)) {
      out[k] = v;
    }
  }
  return out;
}

function buildDenyList(config: ResolvedConfig): Set<string> {
  const denyList = new Set<string>();
  if (config.vcs.source_token_env.length > 0) {
    denyList.add(config.vcs.source_token_env);
  }
  if (config.vcs.exploit_target_token_env.length > 0) {
    denyList.add(config.vcs.exploit_target_token_env);
  }
  return denyList;
}
