import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../log/log.js";
import type { AuthMode, ResolvedConfig } from "../config/defaults.js";
import type { Redactor } from "../redaction/redact.js";
import { enumerate } from "../discovery/enumerate.js";
import { detectSubstrate } from "../substrate/detect.js";
import { preflight } from "../substrate/preflight.js";
import { selectReporter } from "../reporter/select.js";
import {
  type RunState,
  type TargetState,
  initState,
  loadState,
  saveState,
  ensureRunDir,
} from "./state.js";
import { initActive, truncateActive } from "./telemetry.js";
import { runPipelineLoop, setupSignalHandlers, type SignalShutdown, type SpawnHandle } from "./loop.js";
import { reconcileResume } from "./reconcile.js";
import { selectRunner } from "../runner/select.js";
import { writeManifest } from "../manifest/write.js";
import { safeStderr } from "../util/safe-stderr.js";
import { makeProgressReporter } from "../progress/bar.js";
import { runProbePhase, type ProbePhaseResult } from "./probe-phase.js";
import { makeAppLock } from "../app-lock/lock.js";

export interface DispatcherOpts {
  config: ResolvedConfig;
  clock: Clock;
  runId: string;
  mode: "scan-all" | "scan-changes" | "resume";
  cwd: string;
  logger: Logger;
  redactor?: Redactor;
}

interface InitResult {
  state: RunState;
  runDir: string;
}

function snapshotConfig(runDir: string, config: ResolvedConfig): void {
  fs.writeFileSync(path.join(runDir, "config.snapshot.yaml"), yamlStringify(config));
}

function checkFixtureVcsGuard(config: ResolvedConfig, env: NodeJS.ProcessEnv): string | null {
  if (config.output.mode !== "vcs") return null;
  if (env["LBVD_ALLOW_FIXTURE_VCS"] === "1") return null;
  if (env["LBVD_RUNNER"] === "fixture") {
    return "LBVD_RUNNER=fixture with output.mode=vcs requires LBVD_ALLOW_FIXTURE_VCS=1.";
  }
  if (env["LBVD_HTTP_REPLAY"] !== undefined && env["LBVD_HTTP_REPLAY"].length > 0) {
    return "LBVD_HTTP_REPLAY with output.mode=vcs requires LBVD_ALLOW_FIXTURE_VCS=1 (replay returns recorded responses, not real publishes).";
  }
  return null;
}

async function setupNewRun(opts: DispatcherOpts): Promise<InitResult> {
  const runDir = ensureRunDir(opts.cwd, opts.runId);
  snapshotConfig(runDir, opts.config);
  const targetList = await enumerate({
    mode: opts.mode === "resume" ? "scan-all" : opts.mode,
    cwd: opts.cwd,
    config: opts.config,
    logger: opts.logger,
  });
  const targets: Record<string, TargetState> = {};
  for (const t of targetList.targets) {
    targets[t] = newTargetState();
  }
  const state = initState({
    runId: opts.runId,
    config: opts.config,
    startedAt: opts.clock.now().toISOString(),
    targets,
  });
  saveState(runDir, state);
  return { state, runDir };
}

function newTargetState(): TargetState {
  return {
    state: "queued",
    fingerprint: null,
    branch_url: null,
    issue_url: null,
    infra_issue_url: null,
    tracking_issue_url: null,
    error: null,
    stage1_started_at: null,
    stage2_started_at: null,
    completed_at: null,
  };
}

function loadResumeState(opts: DispatcherOpts): { state: RunState; runDir: string } {
  const runDir = path.join(opts.cwd, ".lbvd", opts.runId);
  if (!fs.existsSync(path.join(runDir, "state.json"))) {
    throw new Error(`resume: state.json not found at ${runDir}`);
  }
  return { state: loadState(runDir), runDir };
}

function applyReconcile(runDir: string, state: RunState, logger: Logger): RunState {
  const next = reconcileResume(runDir, state, logger);
  saveState(runDir, next);
  return next;
}

const AUTH_MODE_VALUES: ReadonlySet<string> = new Set(["api_key", "subscription"]);

/**
 * FR-15 / architecture §20.6: resuming with a different auth.mode than the run
 * was started with aborts cleanly.
 *
 * Resilience contract:
 * - Snapshot with `auth` absent (pre-F5 run) → treat as v1 default `api_key`.
 * - Snapshot with `auth: { mode: "api_key" | "subscription" }` → compare.
 * - Snapshot with a malformed `auth` block (non-object, missing/non-string
 *   `mode`, unknown enum value) → refuse with a generic
 *   "config_snapshot.auth is corrupt" message. The attacker-supplied content
 *   is **not** echoed into the operator-facing error (sec review M2; state.json
 *   is treated as untrusted input on resume per architecture §1.3).
 */
function checkResumeAuthMode(state: RunState, current: ResolvedConfig): string | null {
  const snapAny = (state.config_snapshot as { auth?: unknown }).auth;
  if (snapAny === undefined) {
    return current.auth.mode === "api_key"
      ? null
      : `auth-mode mismatch: run started with auth.mode=api_key (pre-F5 snapshot default); current config has auth.mode=${current.auth.mode}.`;
  }
  if (snapAny === null || typeof snapAny !== "object" || Array.isArray(snapAny)) {
    return "config_snapshot.auth is corrupt; cannot resume.";
  }
  const mode = (snapAny as { mode?: unknown }).mode;
  if (typeof mode !== "string" || !AUTH_MODE_VALUES.has(mode)) {
    return "config_snapshot.auth is corrupt; cannot resume.";
  }
  const snapMode = mode as AuthMode;
  if (snapMode === current.auth.mode) return null;
  return `auth-mode mismatch: run started with auth.mode=${snapMode}; current config has auth.mode=${current.auth.mode}.`;
}

interface ProbeStepDeps {
  state: RunState;
  runDir: string;
  config: ResolvedConfig;
  cwd: string;
  runner: import("../runner/interface.js").Runner;
  clock: Clock;
  logger: Logger;
  onSpawn?: (h: SpawnHandle) => void;
  onSpawnEnd?: (h: SpawnHandle) => void;
  onProgress?: import("../progress/bar.js").ProgressReporter;
}

async function runProbePhaseStep(deps: ProbeStepDeps): Promise<ProbePhaseResult> {
  try {
    return await runProbePhase({
      state: deps.state,
      runDir: deps.runDir,
      cwd: deps.cwd,
      config: deps.config,
      runner: deps.runner,
      clock: deps.clock,
      logger: deps.logger,
      ...(deps.onSpawn !== undefined && { onSpawn: deps.onSpawn }),
      ...(deps.onSpawnEnd !== undefined && { onSpawnEnd: deps.onSpawnEnd }),
      ...(deps.onProgress !== undefined && { onProgress: deps.onProgress }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.logger.info("probe.failed", { error: msg });
    return { probe: null };
  }
}

async function cleanupAppLockStale(
  runDir: string,
  config: ResolvedConfig,
  clock: Clock,
  logger: Logger,
): Promise<void> {
  const stage2BudgetMs = config.budgets.stage2_per_finding_seconds * 1000;
  const mutexTimeoutMs = config.budgets.app_mutex_timeout_seconds * 1000;
  const lock = makeAppLock({ runDir, clock, stage2BudgetMs, mutexTimeoutMs });
  try {
    await lock.cleanupStale(stage2BudgetMs, mutexTimeoutMs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.info("app_lock.cleanup_stale_failed", { error: msg });
  }
}

function emptyTargetExit(opts: DispatcherOpts, runDir: string, state: RunState): RunScanResult {
  state.ended_at = opts.clock.now().toISOString();
  saveState(runDir, state);
  writeManifest({ runDir, state, clock: opts.clock, ...(opts.redactor !== undefined && { redactor: opts.redactor }) });
  opts.logger.info("run.no_targets", { run_id: opts.runId });
  return { exitCode: 5 };
}

interface RunScanResult {
  exitCode: number;
}

export async function runDispatcher(opts: DispatcherOpts): Promise<RunScanResult> {
  const guardErr = checkFixtureVcsGuard(opts.config, process.env);
  if (guardErr !== null) {
    safeStderr(`lbvd: ${guardErr}\n`);
    return { exitCode: 3 };
  }
  if (opts.config.runner.kind === "fixture" || process.env["LBVD_RUNNER"] === "fixture") {
    opts.logger.info("runner.fixture_warning", {
      message: "RUNNER=fixture (fixture data only; not a real scan)",
    });
  }

  let state: RunState;
  let runDir: string;
  if (opts.mode === "resume") {
    // Load the snapshot *without* mutating the run dir; the reconcile step
    // is deferred until after all gates (mode-mismatch, substrate) pass so
    // a rejected resume leaves the on-disk state unchanged
    // (post-impl review M1, sec review L1).
    ({ state, runDir } = loadResumeState(opts));
    const mismatch = checkResumeAuthMode(state, opts.config);
    if (mismatch !== null) {
      safeStderr(`lbvd: ${mismatch}\n`);
      return { exitCode: 3 };
    }
  } else {
    const init = await setupNewRun(opts);
    state = init.state;
    runDir = init.runDir;
  }

  initActive(runDir);
  truncateActive(runDir);
  await cleanupAppLockStale(runDir, opts.config, opts.clock, opts.logger);

  // F5.7: substrate gate runs on every dispatcher entry — auth-mode-vs-substrate
  // (FR-15, architecture §20.4) must fire on resumed runs too. Runs *before*
  // reconcile on the resume path so a refused W4 + api_key resume leaves the
  // run dir untouched.
  const substrate = detectSubstrate(process.env);
  const preflightResult = preflight({
    targets: Object.keys(state.targets),
    cwd: opts.cwd,
    config: opts.config,
    substrate,
  });
  if (!preflightResult.ok) {
    safeStderr(`lbvd: preflight refused: ${preflightResult.reason}\n`);
    safeStderr("lbvd: use DIY-cloud for runs of this size.\n");
    return { exitCode: 2 };
  }

  if (opts.mode === "resume") {
    state = applyReconcile(runDir, state, opts.logger);
  }

  if (Object.keys(state.targets).length === 0) {
    return emptyTargetExit(opts, runDir, state);
  }

  const reporter = selectReporter({ config: opts.config, runDir, logger: opts.logger, clock: opts.clock });
  try {
    await reporter.verifyAccess();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    safeStderr(`lbvd: reporter access check failed: ${msg}\n`);
    return { exitCode: 3 };
  }

  const runner = selectRunner({
    config: opts.config,
    env: process.env,
    logger: opts.logger,
    clock: opts.clock,
    ...(opts.redactor !== undefined && { redactor: opts.redactor }),
  });

  // FR-17 / sec-review H2: install signal handlers BEFORE the probe phase
  // so a SIGINT/SIGTERM delivered during the probe propagates to the
  // probe subprocess and produces the FR-16 user_interrupt termination
  // record + manifest. `inflightSpawns` is shared with the pipeline loop.
  const inflightSpawns = new Set<SpawnHandle>();
  const signalShutdown = setupSignalHandlers({
    inflightSpawns,
    runner,
    logger: opts.logger,
  });
  const onSpawn = (h: SpawnHandle): void => {
    inflightSpawns.add(h);
  };
  const onSpawnEnd = (h: SpawnHandle): void => {
    inflightSpawns.delete(h);
  };

  // FR-17 user-feedback: the probe can take minutes. Create the progress
  // reporter up-front so the probe phase can post status lines and the
  // pipeline loop can re-use the same instance.
  const progress = makeProgressReporter(() => state.targets, opts.redactor);

  let loopResult: { exitCode: number };
  try {
    const probeResult = await runProbePhaseStep({
      state,
      runDir,
      config: opts.config,
      cwd: opts.cwd,
      runner,
      clock: opts.clock,
      logger: opts.logger,
      onSpawn,
      onSpawnEnd,
      onProgress: progress,
    });

    if (signalShutdown.killed()) {
      loopResult = recordSignalTermination(state, runDir, signalShutdown, opts.clock);
    } else {
      loopResult = await runPipelineLoop({
        state,
        runDir,
        config: opts.config,
        runner,
        reporter,
        clock: opts.clock,
        logger: opts.logger,
        cwd: opts.cwd,
        appProbe: probeResult.probe,
        signalShutdown,
        inflightSpawns,
        onProgress: progress,
      });
    }
  } finally {
    progress.stop();
    signalShutdown.cleanup();
  }

  state.ended_at = opts.clock.now().toISOString();
  saveState(runDir, state);
  writeManifest({ runDir, state, clock: opts.clock, ...(opts.redactor !== undefined && { redactor: opts.redactor }) });

  return { exitCode: loopResult.exitCode };
}

function recordSignalTermination(
  state: RunState,
  runDir: string,
  signalShutdown: SignalShutdown,
  clock: Clock,
): { exitCode: number } {
  const sig = signalShutdown.signal();
  const term: import("./state.js").Termination = {
    kind: "user_interrupt",
    at: clock.now().toISOString(),
    reason: `run interrupted by ${sig ?? "unknown"} signal during probe phase`,
  };
  if (sig !== null) term.signal = sig;
  state.terminations.push(term);
  saveState(runDir, state);
  return { exitCode: 6 };
}

