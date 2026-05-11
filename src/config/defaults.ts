export type ScanScope = "hint_only" | "hint+verify" | "repo_wide";
export type OutputMode = "vcs" | "local";
export type VcsProvider = "github" | "gitlab";
export type RunnerKind = "sdk" | "fixture";

export type BuiltinGroup =
  | "lockfiles"
  | "vendored"
  | "build_outputs"
  | "minified"
  | "binary_assets"
  | "generated_code"
  | "oversized"
  | "config_files";

export type AuthMode = "api_key" | "subscription";

export interface ResolvedConfig {
  schema_version: 1;
  concurrency: number;
  scan: { scope: ScanScope };
  budgets: {
    stage1_per_finding_seconds: number;
    stage2_per_finding_seconds: number;
    run_seconds: number;
    app_probe_seconds: number;
    app_mutex_timeout_seconds: number;
  };
  blacklist: {
    disabled_builtins: BuiltinGroup[];
    patterns: string[];
  };
  vcs: {
    provider: VcsProvider;
    repo: string;
    default_branch: string;
    source_token_env: string;
    exploit_target_repo: string;
    exploit_target_token_env: string;
  };
  output: {
    mode: OutputMode;
    local_dir: string;
  };
  preflight: {
    enabled_on_substrate: "web-sandbox" | "diy-cloud" | "none";
    max_targets: number;
    max_tree_bytes: number;
  };
  runner: {
    kind: RunnerKind;
    sdk: { model: string };
  };
  auth: { mode: AuthMode };
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  schema_version: 1,
  concurrency: 4,
  scan: { scope: "hint+verify" },
  budgets: {
    stage1_per_finding_seconds: 120,
    stage2_per_finding_seconds: 600,
    run_seconds: 14400,
    app_probe_seconds: 300,
    app_mutex_timeout_seconds: 120,
  },
  blacklist: {
    disabled_builtins: [],
    patterns: [],
  },
  vcs: {
    provider: "github",
    repo: "",
    default_branch: "main",
    source_token_env: "GITHUB_TOKEN",
    exploit_target_repo: "",
    exploit_target_token_env: "",
  },
  output: {
    mode: "vcs",
    local_dir: ".lbvd/local-report",
  },
  preflight: {
    enabled_on_substrate: "web-sandbox",
    max_targets: 5000,
    max_tree_bytes: 2_147_483_648,
  },
  runner: {
    kind: "sdk",
    sdk: { model: "claude-opus-4-7" },
  },
  auth: { mode: "api_key" },
};
