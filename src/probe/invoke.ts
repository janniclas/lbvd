/**
 * Dispatcher-orchestrated probe phase (architecture §22).
 *
 * Spawns the probe agent, waits for it within the configured probe
 * wall-clock budget, reads its intermediate `app-probe.json` from the
 * probe subtree, validates it, and promotes the canonical copy to
 * `<runDir>/app-probe.json` (dispatcher zone). Returns the result that
 * Stage 2 will consume as read-only context.
 *
 * Hard constraint: the dispatcher-zone `app-probe.json` is written ONLY
 * from this module (plans/implementation.md §10). The probe agent never
 * writes to the dispatcher zone directly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../log/log.js";
import type { ResolvedConfig } from "../config/defaults.js";
import type { Runner } from "../runner/interface.js";
import { buildAgentEnv } from "../runner/safe-env.js";
import { atomicWriteJson } from "../dispatcher/state.js";
import { validateAppProbe, hasNonEmptyCommandArrays, type AppProbe } from "./schema.js";

export interface InvokeProbeOpts {
  runDir: string;
  probeSubtree: string;
  repoRoot: string;
  config: ResolvedConfig;
  runner: Runner;
  clock: Clock;
  logger: Logger;
  budgetSeconds: number;
  onSpawn?: (h: { pid: number }) => void;
  onSpawnEnd?: (h: { pid: number }) => void;
}

export interface InvokeProbeResult {
  probe: AppProbe;
  pid: number;
}

interface BudgetTimer {
  fired: { value: boolean };
  cancel: () => void;
}

function armProbeBudget(
  opts: InvokeProbeOpts,
  pidPromise: Promise<number>,
): BudgetTimer {
  const fired = { value: false };
  const ms = opts.budgetSeconds * 1000;
  const handle = setTimeout(async () => {
    fired.value = true;
    const pid = await pidPromise;
    void opts.runner.abort(pid, 5000);
  }, ms);
  return { fired, cancel: () => clearTimeout(handle) };
}

function synthesizeUnstartable(reason: string, wallSeconds: number): AppProbe {
  return {
    schema_version: 1,
    startable: false,
    start_commands: [],
    stop_commands: [],
    port: null,
    health_check_url: null,
    startup_timeout_seconds: 0,
    pre_conditions: [],
    probe_narrative: reason,
    tried: false,
    successfully_started: false,
    failure_reason: reason,
    probe_token_usage: { input: 0, output: 0 },
    probe_wall_seconds: wallSeconds,
  };
}

function readProbeOutput(probeSubtree: string): unknown | null {
  const p = path.join(probeSubtree, "app-probe.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Validate the probe-agent output. Returns a normalized `AppProbe` or
 * `null` if anything was wrong (missing file, malformed JSON, schema
 * violation, or `startable: true` without non-empty command arrays).
 */
function readAndValidateProbeOutput(probeSubtree: string): AppProbe | null {
  const raw = readProbeOutput(probeSubtree);
  if (raw === null) return null;
  let parsed: AppProbe;
  try {
    parsed = validateAppProbe(raw);
  } catch {
    return null;
  }
  if (parsed.startable && !hasNonEmptyCommandArrays(parsed)) return null;
  return parsed;
}

interface RunAgentResult {
  pid: number;
  exitCode: number;
  wallSeconds: number;
  budgetFired: boolean;
}

async function runProbeAgent(opts: InvokeProbeOpts): Promise<RunAgentResult> {
  let resolvePid: (n: number) => void = () => {};
  const pidPromise = new Promise<number>((r) => {
    resolvePid = r;
  });
  const budget = armProbeBudget(opts, pidPromise);
  const startMono = opts.clock.monotonicMs();
  try {
    const spawned = await opts.runner.spawnProbe({
      runDir: opts.runDir,
      probeSubtree: opts.probeSubtree,
      repoRoot: opts.repoRoot,
      capabilities: ["fs:read", "fs:write", "fs:write:targetSubtree", "net", "shell"],
      budgetSeconds: opts.budgetSeconds,
      redactedEnv: buildAgentEnv({
        config: opts.config,
        env: process.env,
        extra: { LBVD_REPO_ROOT: opts.repoRoot },
      }),
      logger: opts.logger,
    });
    resolvePid(spawned.pid);
    const handle = { pid: spawned.pid };
    opts.onSpawn?.(handle);
    let exitCode = -1;
    try {
      const exit = await spawned.done;
      exitCode = exit.code;
    } finally {
      opts.onSpawnEnd?.(handle);
    }
    return {
      pid: spawned.pid,
      exitCode,
      wallSeconds: (opts.clock.monotonicMs() - startMono) / 1000,
      budgetFired: budget.fired.value,
    };
  } finally {
    budget.cancel();
  }
}

function writeCanonicalProbe(runDir: string, probe: AppProbe): void {
  // Dispatcher zone write — sole owner per plans/implementation.md §10.
  // Atomic write-temp-then-rename per architecture §3.6 / decision 18 so a
  // SIGKILL or power loss mid-write cannot leave a torn JSON file
  // (sec review H1).
  atomicWriteJson(path.join(runDir, "app-probe.json"), probe);
}

export async function invokeProbe(opts: InvokeProbeOpts): Promise<InvokeProbeResult> {
  fs.mkdirSync(opts.probeSubtree, { recursive: true });
  const run = await runProbeAgent(opts);
  if (run.budgetFired) {
    const probe = synthesizeUnstartable("probe_wall_clock_cap", run.wallSeconds);
    writeCanonicalProbe(opts.runDir, probe);
    return { probe, pid: run.pid };
  }
  if (run.exitCode !== 0) {
    const probe = synthesizeUnstartable(`probe agent exited with code ${run.exitCode}`, run.wallSeconds);
    writeCanonicalProbe(opts.runDir, probe);
    return { probe, pid: run.pid };
  }
  const validated = readAndValidateProbeOutput(opts.probeSubtree);
  if (validated === null) {
    const probe = synthesizeUnstartable("probe output missing or invalid", run.wallSeconds);
    writeCanonicalProbe(opts.runDir, probe);
    return { probe, pid: run.pid };
  }
  // Dispatcher overwrites the probe-wall-seconds field with its measurement.
  const normalized: AppProbe = { ...validated, probe_wall_seconds: run.wallSeconds };
  writeCanonicalProbe(opts.runDir, normalized);
  return { probe: normalized, pid: run.pid };
}
