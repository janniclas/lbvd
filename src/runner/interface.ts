import type { Logger } from "../log/log.js";

// Capability set passed from dispatcher → runner. The SDK tool shim
// (`sdk-tool-shim.ts`) consults this list per tool call.
//   fs:read                  — read tools (Read/Glob/Grep) inside repoRoot or targetSubtree.
//   fs:write                 — write tools anywhere allowed by the shim's containment check.
//   fs:write:targetSubtree   — narrow write capability scoped to the agent's
//                              own targetSubtree only. Granted to BOTH stages
//                              so the agent can produce finding.json /
//                              outcome.json without needing full fs:write.
//   net                      — WebFetch / WebSearch.
//   shell                    — Bash / BashOutput / KillShell.
//
// Architectural note (`architecture.md` §1.3.1): `Runner.spawn` MUST return
// promptly with a usable pid; the budget timer's abort path relies on
// `pidPromise` resolving before the timer fires.
export type Capability =
  | "fs:read"
  | "fs:write"
  | "fs:write:targetSubtree"
  | "net"
  | "shell";

export interface RunnerInput {
  runDir: string;
  targetSubtree: string;
  targetFile: string;
  repoRoot: string;
  stage: 1 | 2;
  capabilities: Capability[];
  scanScope?: "hint_only" | "hint+verify" | "repo_wide";
  finding?: unknown;
  /**
   * App-probe context passed to Stage 2 only. When the probe ran and
   * succeeded, this carries the validated start/stop commands, port,
   * health-check URL, and startup timeout. When the probe declared
   * `startable: false` (or the dispatcher could not produce a probe),
   * Stage 2 receives `null` and the `AcquireAppLock` / `ReleaseAppLock`
   * tools are not exposed (architecture §22.6, §22.10).
   */
  appProbe?: AppProbeContext | null;
  /**
   * Filesystem-mutex coordinates passed to Stage 2 when `appProbe` is
   * present and `startable: true`. The agent-host inside the subprocess
   * reconstructs an `AppLock` from these values so it can serialize the
   * Tier 1 verification step (architecture §22.4).
   */
  appLock?: AppLockHandle | null;
  budgetSeconds: number;
  redactedEnv: NodeJS.ProcessEnv;
  logger: Logger;
}

/**
 * Subset of the app-probe result that Stage 2 needs at runtime. The
 * dispatcher revalidates `start_commands`/`stop_commands` are non-empty
 * string arrays before constructing this payload (architecture §22.3 /
 * implementation §6.7 F7.3).
 */
export interface AppProbeContext {
  startable: boolean;
  start_commands: string[];
  stop_commands: string[];
  port: number | null;
  health_check_url: string | null;
  startup_timeout_seconds: number;
}

/**
 * Coordinates the Stage 2 agent-host subprocess needs to reconstruct an
 * `AppLock` matching the dispatcher's instance. The lock path is derived
 * from `runDir` via `app-lock/lockPathFor` — the single source of truth
 * — and is intentionally not duplicated here (sec L1 / impl M2).
 */
export interface AppLockHandle {
  mutexTimeoutMs: number;
  stage2BudgetMs: number;
}

export interface ProbeRunnerInput {
  runDir: string;
  probeSubtree: string;
  repoRoot: string;
  capabilities: Capability[];
  budgetSeconds: number;
  redactedEnv: NodeJS.ProcessEnv;
  logger: Logger;
}

export interface RunnerExit {
  code: number;
  signal: NodeJS.Signals | null;
  wallSeconds: number;
}

export interface SpawnedRunner {
  pid: number;
  done: Promise<RunnerExit>;
}

export interface Runner {
  kind: "sdk" | "fixture";
  spawn(input: RunnerInput): Promise<SpawnedRunner>;
  spawnProbe(input: ProbeRunnerInput): Promise<SpawnedRunner>;
  abort(pid: number, gracefulMs?: number): Promise<void>;
}
