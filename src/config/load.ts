import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_CONFIG, type AuthMode, type ResolvedConfig, type ScanScope } from "./defaults.js";
import { validateConfig } from "./schema.js";
import { safeStderr } from "../util/safe-stderr.js";

export type { AuthMode, ResolvedConfig, ScanScope } from "./defaults.js";

export interface CliFlags {
  concurrency?: number;
  scope?: ScanScope;
  configPath?: string;
  runId?: string;
  dryRun?: boolean;
  authMode?: AuthMode;
}

const AUTH_MODE_VALUES: ReadonlySet<string> = new Set(["api_key", "subscription"]);

export const AUTH_MODE_ENV_NAME = "LBVD_AUTH_MODE";

export type AuthEnvVar = "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN";

const MODE_ENV_VAR: Record<AuthMode, AuthEnvVar> = {
  api_key: "ANTHROPIC_API_KEY",
  subscription: "CLAUDE_CODE_OAUTH_TOKEN",
};

interface LoadOpts {
  configPath: string;
  flags: CliFlags;
  env: NodeJS.ProcessEnv;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 3,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

function deepMerge<T>(base: T, overlay: unknown): T {
  if (
    overlay === null ||
    overlay === undefined ||
    typeof overlay !== "object" ||
    Array.isArray(overlay)
  ) {
    return (overlay === undefined ? base : (overlay as T)) ?? base;
  }
  const baseObj = base as Record<string, unknown>;
  const overObj = overlay as Record<string, unknown>;
  const out: Record<string, unknown> = { ...baseObj };
  for (const [k, v] of Object.entries(overObj)) {
    if (v !== undefined) {
      out[k] = deepMerge(baseObj[k], v);
    }
  }
  return out as T;
}

function readFileIfExists(p: string): unknown | null {
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  try {
    return parseYaml(raw) ?? {};
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ConfigError(`config: YAML parse failed at ${p}: ${msg}`);
  }
}

function applyFlagOverrides<T extends ResolvedConfig>(cfg: T, flags: CliFlags): T {
  if (flags.concurrency !== undefined) {
    cfg.concurrency = flags.concurrency;
  }
  if (flags.scope !== undefined) {
    cfg.scan.scope = flags.scope;
  }
  if (flags.authMode !== undefined) {
    cfg.auth.mode = flags.authMode;
  }
  return cfg;
}

function parseAuthModeEnv(raw: string | undefined): AuthMode | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!AUTH_MODE_VALUES.has(trimmed)) {
    throw new ConfigError(
      `config: ${AUTH_MODE_ENV_NAME}=${JSON.stringify(raw)} must be one of: api_key, subscription.`,
    );
  }
  return trimmed as AuthMode;
}

function applyAuthModeEnv<T extends ResolvedConfig>(
  cfg: T,
  env: NodeJS.ProcessEnv,
  flags: CliFlags,
): T {
  if (flags.authMode !== undefined) return cfg;
  const envMode = parseAuthModeEnv(env[AUTH_MODE_ENV_NAME]);
  if (envMode !== undefined) {
    cfg.auth.mode = envMode;
  }
  return cfg;
}

function checkLocalModeWarning(cfg: ResolvedConfig, configFromFile: unknown): void {
  if (cfg.output.mode !== "local") return;
  const fileObj = configFromFile as Record<string, unknown> | null;
  const vcsKeysSet =
    fileObj !== null &&
    typeof fileObj["vcs"] === "object" &&
    fileObj["vcs"] !== null &&
    Object.keys(fileObj["vcs"] as Record<string, unknown>).length > 0;
  if (vcsKeysSet) {
    safeStderr("lbvd: warning: output.mode=local; vcs.* keys are ignored.\n");
  }
}

function checkTokensIfNeeded(cfg: ResolvedConfig, env: NodeJS.ProcessEnv, dryRun: boolean): void {
  if (dryRun) return;
  if (cfg.output.mode === "local") return;
  const sourceTok = env[cfg.vcs.source_token_env];
  if (!sourceTok || sourceTok.length === 0) {
    throw new ConfigError(
      `config: vcs.source_token_env=${cfg.vcs.source_token_env} is unset; export it before running.`,
    );
  }
  if (cfg.vcs.exploit_target_repo.length > 0) {
    if (cfg.vcs.exploit_target_token_env.length === 0) {
      throw new ConfigError(
        "config: vcs.exploit_target_repo set but vcs.exploit_target_token_env is empty.",
      );
    }
    const targetTok = env[cfg.vcs.exploit_target_token_env];
    if (!targetTok || targetTok.length === 0) {
      throw new ConfigError(
        `config: vcs.exploit_target_token_env=${cfg.vcs.exploit_target_token_env} is unset.`,
      );
    }
  }
}

export function loadConfig(opts: LoadOpts): ResolvedConfig {
  const fileData = readFileIfExists(opts.configPath);
  validateConfig(fileData ?? {}, opts.configPath);
  let merged: ResolvedConfig = deepMerge(structuredClone(DEFAULT_CONFIG), fileData);
  merged = applyAuthModeEnv(merged, opts.env, opts.flags);
  merged = applyFlagOverrides(merged, opts.flags);
  if (merged.concurrency < 1 || !Number.isInteger(merged.concurrency)) {
    throw new ConfigError(`config: concurrency must be integer ≥ 1 (got ${merged.concurrency}).`);
  }
  if (merged.budgets.stage2_per_finding_seconds <= 0) {
    throw new ConfigError("config: budgets.stage2_per_finding_seconds must be > 0.");
  }
  if (merged.budgets.run_seconds <= 0) {
    throw new ConfigError("config: budgets.run_seconds must be > 0.");
  }
  if (merged.budgets.app_probe_seconds <= 0) {
    throw new ConfigError("config: budgets.app_probe_seconds must be > 0.");
  }
  if (merged.budgets.app_mutex_timeout_seconds <= 0) {
    throw new ConfigError("config: budgets.app_mutex_timeout_seconds must be > 0.");
  }
  checkLocalModeWarning(merged, fileData);
  checkTokensIfNeeded(merged, opts.env, opts.flags.dryRun ?? false);
  return merged;
}

export function resolveConfigPath(cwd: string, override?: string): string {
  return override ?? path.join(cwd, "lbvd.yaml");
}

export interface ResolvedAuthCredential {
  tokenValue: string;
  envVarName: AuthEnvVar;
}

/**
 * FR-15: capture the credential by literal value at startup so the redaction
 * builder can mask it everywhere downstream. The single env read for the auth
 * credential lives here; the runner's safe-env chokepoint also reads it but
 * only for env-passthrough into the agent subprocess. No other module reads
 * these vars directly (lint rule, implementation plan §10).
 *
 * SECURITY: error messages must reference the env var **name** only — never
 * embed the raw value. These throws run *before* `makeRedactor` has been
 * constructed with the literal, so a value in the message would land in
 * stderr unmasked (the catch site calls `safeStderr`, which uses the
 * module-level redactor with no literal floor). See sec review L2.
 */
export function resolveAuthCredential(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv,
): ResolvedAuthCredential {
  const envVarName = MODE_ENV_VAR[config.auth.mode];
  const raw = env[envVarName];
  if (raw === undefined || raw.length === 0) {
    throw new ConfigError(
      `auth: ${envVarName} is unset; auth.mode=${config.auth.mode} requires it. ` +
        (config.auth.mode === "subscription"
          ? "Run 'claude setup-token' on a host with browser access, then export the token here."
          : "Export your Anthropic API key as ANTHROPIC_API_KEY."),
    );
  }
  if (raw.trim().length === 0) {
    throw new ConfigError(
      `auth: ${envVarName} is set but blank; auth.mode=${config.auth.mode} requires a non-empty value.`,
    );
  }
  return { tokenValue: raw, envVarName };
}
