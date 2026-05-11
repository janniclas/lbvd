/**
 * Probe phase orchestration (FR-17 / architecture §22). Runs once per
 * run, after discovery and stale-lock cleanup, before the per-target
 * pipeline loop. Writes the canonical `<runDir>/app-probe.json`.
 *
 * The implementation is split out of `run.ts` so the main dispatcher
 * function stays under the cognitive-complexity budget (CLAUDE.md).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../log/log.js";
import type { ResolvedConfig } from "../config/defaults.js";
import type { Runner } from "../runner/interface.js";
import type { AppProbeContext } from "../runner/interface.js";
import { invokeProbe } from "../probe/invoke.js";
import {
  validateAppProbe,
  hasNonEmptyCommandArrays,
  type AppProbe,
} from "../probe/schema.js";
import {
  type RunState,
  getAppProbeState,
  setAppProbeState,
  saveState,
} from "./state.js";
import type { ProgressReporter } from "../progress/bar.js";
import { sanitizeOneLine } from "../util/sanitize-text.js";

export interface ProbePhaseOpts {
  state: RunState;
  runDir: string;
  cwd: string;
  config: ResolvedConfig;
  runner: Runner;
  clock: Clock;
  logger: Logger;
  /**
   * FR-17 / sec H2: PID-tracking hooks so the probe agent participates
   * in signal-shutdown the same way Stage 1 / Stage 2 do. The dispatcher
   * passes its shared `inflightSpawns` set indirectly via these hooks.
   */
  onSpawn?: (h: { pid: number }) => void;
  onSpawnEnd?: (h: { pid: number }) => void;
  /**
   * Optional progress reporter so the user sees status updates while the
   * probe agent works. Non-TTY callers can omit it; the reporter itself
   * is already TTY-aware and a no-op on non-TTY stderr.
   */
  onProgress?: ProgressReporter;
}

export interface ProbePhaseResult {
  probe: AppProbe | null;
}

function dispatcherProbeFile(runDir: string): string {
  return path.join(runDir, "app-probe.json");
}

function probeSubtreeFor(runDir: string): string {
  return path.join(runDir, "probe");
}

function readDispatcherZoneProbe(runDir: string): AppProbe | null {
  const p = dispatcherProbeFile(runDir);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = validateAppProbe(JSON.parse(fs.readFileSync(p, "utf8")));
    if (parsed.startable && !hasNonEmptyCommandArrays(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function nowIso(clock: Clock): string {
  return clock.now().toISOString();
}

/**
 * Convert the probe's full record into the subset Stage 2 needs. Returns
 * `null` when the probe was not startable; callers should pass that null
 * through to Stage 2 so the prompt + downgrade pipeline behaves
 * consistently (architecture §22.6).
 */
export function toStage2Context(probe: AppProbe | null): AppProbeContext | null {
  if (probe === null) return null;
  if (!probe.startable) {
    return {
      startable: false,
      start_commands: [],
      stop_commands: [],
      port: probe.port,
      health_check_url: probe.health_check_url,
      startup_timeout_seconds: probe.startup_timeout_seconds,
    };
  }
  if (!hasNonEmptyCommandArrays(probe)) return null;
  return {
    startable: true,
    start_commands: [...probe.start_commands],
    stop_commands: [...probe.stop_commands],
    port: probe.port,
    health_check_url: probe.health_check_url,
    startup_timeout_seconds: probe.startup_timeout_seconds,
  };
}

/** TTY heartbeat cadence while the probe agent is running. */
const PROBE_HEARTBEAT_MS = 5_000;

function announceProbeStart(opts: ProbePhaseOpts): void {
  const budget = opts.config.budgets.app_probe_seconds;
  opts.logger.info("probe.start", { budget_seconds: budget });
  opts.onProgress?.status(`Probing app startup (budget ${budget}s)`);
}

function announceStartableDone(
  opts: ProbePhaseOpts,
  probe: AppProbe,
  wall: number,
): void {
  opts.logger.info("probe.done", {
    startable: true,
    port: probe.port,
    wall_seconds: wall,
  });
  const portText = probe.port !== null ? `port ${probe.port}, ` : "";
  opts.onProgress?.status(`Probe: startable (${portText}${wall}s)`);
}

function announceNotStartableDone(
  opts: ProbePhaseOpts,
  probe: AppProbe,
  wall: number,
): void {
  // `failure_reason` is agent-controlled (architecture §22.2: the probe
  // agent has shell + net + fs:read + fs:write:probeSubtree). Strip
  // ANSI/control bytes before it reaches stderr or the structured-log
  // chokepoint. Sec review H1; schema caps length at 4096, this caps the
  // operator-visible label at 200.
  const reason = sanitizeOneLine(probe.failure_reason ?? "unknown reason");
  opts.logger.info("probe.done", {
    startable: false,
    failure_reason: reason,
    wall_seconds: wall,
  });
  opts.onProgress?.status(`Probe: not startable (${reason})`);
}

function announceProbeDone(opts: ProbePhaseOpts, probe: AppProbe, wallMs: number): void {
  const wall = Math.round(wallMs / 1000);
  if (probe.startable) {
    announceStartableDone(opts, probe, wall);
    return;
  }
  announceNotStartableDone(opts, probe, wall);
}

function startHeartbeat(opts: ProbePhaseOpts, startMs: number): () => void {
  const reporter = opts.onProgress;
  if (reporter === undefined) return () => {};
  const budget = opts.config.budgets.app_probe_seconds;
  const tick = (): void => {
    const elapsed = Math.round((opts.clock.monotonicMs() - startMs) / 1000);
    reporter.status(`Probing app startup: ${elapsed}s elapsed (budget ${budget}s)`);
  };
  const handle = setInterval(tick, PROBE_HEARTBEAT_MS);
  handle.unref();
  return () => clearInterval(handle);
}

async function runFreshProbe(opts: ProbePhaseOpts): Promise<AppProbe> {
  setAppProbeState(opts.state, {
    state: "running",
    startable: null,
    completed_at: null,
  });
  saveState(opts.runDir, opts.state);
  announceProbeStart(opts);
  const startMs = opts.clock.monotonicMs();
  const stopHeartbeat = startHeartbeat(opts, startMs);
  let result;
  try {
    result = await invokeProbe({
      runDir: opts.runDir,
      probeSubtree: probeSubtreeFor(opts.runDir),
      repoRoot: opts.cwd,
      config: opts.config,
      runner: opts.runner,
      clock: opts.clock,
      logger: opts.logger,
      budgetSeconds: opts.config.budgets.app_probe_seconds,
      ...(opts.onSpawn !== undefined && { onSpawn: opts.onSpawn }),
      ...(opts.onSpawnEnd !== undefined && { onSpawnEnd: opts.onSpawnEnd }),
    });
  } finally {
    stopHeartbeat();
  }
  announceProbeDone(opts, result.probe, opts.clock.monotonicMs() - startMs);
  setAppProbeState(opts.state, {
    state: "done",
    startable: result.probe.startable,
    completed_at: nowIso(opts.clock),
  });
  saveState(opts.runDir, opts.state);
  return result.probe;
}

/**
 * Run the probe phase. Returns the probe record (or `null` if the
 * dispatcher refused to even attempt the probe — only happens when
 * pre-resume state is already `done` and the dispatcher-zone file is
 * present, which we still surface as a usable probe).
 */
export async function runProbePhase(opts: ProbePhaseOpts): Promise<ProbePhaseResult> {
  const current = getAppProbeState(opts.state);
  if (current.state === "done") {
    const existing = readDispatcherZoneProbe(opts.runDir);
    if (existing !== null) {
      opts.logger.info("probe.reused", { startable: existing.startable });
      opts.onProgress?.status(
        `Probe: reusing prior result (startable=${existing.startable})`,
      );
      return { probe: existing };
    }
    // File went missing or is corrupt; the run state says we already did
    // the probe but the dispatcher zone is empty. Re-run rather than
    // abort — architecture §22.11 / impl F7.11.
    opts.logger.info("probe.rerun_missing_dispatcher_zone", {});
    opts.onProgress?.status("Probe: prior result missing, re-running");
  }
  const probe = await runFreshProbe(opts);
  return { probe };
}
