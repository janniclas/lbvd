import { ConfigError } from "./load.js";

const KNOWN_TOP: ReadonlySet<string> = new Set([
  "schema_version",
  "concurrency",
  "scan",
  "budgets",
  "blacklist",
  "vcs",
  "output",
  "preflight",
  "runner",
  "tokens",
  "auth",
]);

const KNOWN_NESTED: Record<string, ReadonlySet<string>> = {
  scan: new Set(["scope"]),
  budgets: new Set([
    "stage1_per_finding_seconds",
    "stage2_per_finding_seconds",
    "run_seconds",
    "app_probe_seconds",
    "app_mutex_timeout_seconds",
  ]),
  blacklist: new Set(["disabled_builtins", "patterns"]),
  vcs: new Set([
    "provider",
    "repo",
    "default_branch",
    "source_token_env",
    "exploit_target_repo",
    "exploit_target_token_env",
  ]),
  output: new Set(["mode", "local_dir"]),
  preflight: new Set(["enabled_on_substrate", "max_targets", "max_tree_bytes"]),
  runner: new Set(["kind", "sdk"]),
  "runner.sdk": new Set(["model"]),
  tokens: new Set([]),
  auth: new Set(["mode"]),
};

const AUTH_MODES: ReadonlySet<string> = new Set(["api_key", "subscription"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkKeys(obj: Record<string, unknown>, known: ReadonlySet<string>, scope: string): void {
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) {
      throw new ConfigError(`config: unknown key '${k}' in ${scope}.`);
    }
  }
}

function checkNested(parent: Record<string, unknown>, key: string): void {
  const child = parent[key];
  if (!isObj(child)) return;
  const known = KNOWN_NESTED[key];
  if (known === undefined) return;
  checkKeys(child, known, key);
  if (key === "runner") {
    const sdk = (child as Record<string, unknown>)["sdk"];
    if (isObj(sdk)) {
      const knownSdk = KNOWN_NESTED["runner.sdk"];
      if (knownSdk !== undefined) checkKeys(sdk, knownSdk, "runner.sdk");
    }
  }
}

function checkAuthMode(data: Record<string, unknown>): void {
  const auth = data["auth"];
  if (!isObj(auth)) return;
  const mode = auth["mode"];
  if (mode === undefined) return;
  if (typeof mode !== "string" || !AUTH_MODES.has(mode)) {
    throw new ConfigError(
      `config: auth.mode must be one of: api_key, subscription (got ${JSON.stringify(mode)}).`,
    );
  }
}

export function validateConfig(data: unknown, source: string): void {
  if (!isObj(data)) {
    if (data === null || data === undefined) return;
    throw new ConfigError(`config: ${source} top-level must be an object.`);
  }
  checkKeys(data, KNOWN_TOP, "(top-level)");
  for (const k of Object.keys(KNOWN_NESTED)) {
    if (!k.includes(".")) checkNested(data, k);
  }
  checkAuthMode(data);
}
