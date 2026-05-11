import type { Clock } from "../clock/clock.js";
import type { Logger } from "../log/log.js";
import type { ResolvedConfig } from "../config/defaults.js";
import type { Runner } from "../runner/interface.js";
import type { Reporter } from "../reporter/interface.js";
import type { RunState, Termination } from "./state.js";
import { TERMINAL_STATES, saveState } from "./state.js";
import { SlotPool } from "./slot.js";
import { runPipeline } from "./pipeline.js";
import type { ProgressReporter } from "../progress/bar.js";
import type { AppProbe } from "../probe/schema.js";

export interface LoopOpts {
  state: RunState;
  runDir: string;
  config: ResolvedConfig;
  runner: Runner;
  reporter: Reporter;
  clock: Clock;
  logger: Logger;
  cwd: string;
  appProbe: AppProbe | null;
  /**
   * Externally-provided signal shutdown handle. When passed, the loop
   * does not install its own SIGINT/SIGTERM handlers — the caller owns
   * them so the probe phase can run under the same handlers (FR-17 / H2).
   */
  signalShutdown?: SignalShutdown;
  /** Externally-provided inflight-spawn tracking set (shares ownership). */
  inflightSpawns?: Set<SpawnHandle>;
  onProgress?: ProgressReporter;
}

export interface LoopResult {
  exitCode: number;
}

export interface SpawnHandle {
  pid: number;
}

function pendingTargets(state: RunState): string[] {
  return Object.entries(state.targets)
    .filter(([, t]) => !TERMINAL_STATES.has(t.state))
    .map(([k]) => k)
    .sort();
}

async function abortAllInflight(
  inflightSpawns: Set<SpawnHandle>,
  runner: Runner,
  logger: Logger,
  context: "run_budget" | "signal_shutdown",
): Promise<void> {
  const ops = [...inflightSpawns].map(async (h) => {
    try {
      await runner.abort(h.pid, 10_000);
    } catch (e) {
      logger.debug(`${context}.abort_failed`, {
        pid: h.pid,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
  await Promise.all(ops);
}

export interface SignalShutdown {
  killed: () => boolean;
  signal: () => "SIGINT" | "SIGTERM" | null;
  cleanup: () => void;
}

// exported for unit tests only
export function setupSignalHandlers(opts: {
  inflightSpawns: Set<SpawnHandle>;
  runner: Runner;
  logger: Logger;
}): SignalShutdown {
  let killed = false;
  let receivedSignal: "SIGINT" | "SIGTERM" | null = null;

  const makeHandler = (sig: "SIGINT" | "SIGTERM") => (): void => {
    if (killed) return;
    killed = true;
    receivedSignal = sig;
    opts.logger.info("signal_shutdown.fired", { signal: sig });
    void abortAllInflight(opts.inflightSpawns, opts.runner, opts.logger, "signal_shutdown");
  };

  const sigintHandler = makeHandler("SIGINT");
  const sigtermHandler = makeHandler("SIGTERM");

  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  return {
    killed: () => killed,
    signal: () => receivedSignal,
    cleanup: () => {
      process.removeListener("SIGINT", sigintHandler);
      process.removeListener("SIGTERM", sigtermHandler);
    },
  };
}

export async function runPipelineLoop(opts: LoopOpts): Promise<LoopResult> {
  const slots = new SlotPool(opts.config.concurrency);
  const inflight = new Set<Promise<void>>();
  const inflightSpawns = opts.inflightSpawns ?? new Set<SpawnHandle>();
  const ownsSignals = opts.signalShutdown === undefined;
  let runBudgetKilled = false;

  const onSpawn = (h: SpawnHandle): void => {
    inflightSpawns.add(h);
  };
  const onSpawnEnd = (h: SpawnHandle): void => {
    inflightSpawns.delete(h);
  };

  const runBudgetMs = opts.config.budgets.run_seconds * 1000;
  const runBudgetTimer = setTimeout(() => {
    runBudgetKilled = true;
    opts.logger.info("run_budget.fired", { budget_seconds: opts.config.budgets.run_seconds });
    void abortAllInflight(inflightSpawns, opts.runner, opts.logger, "run_budget");
  }, runBudgetMs);

  const signalShutdown = opts.signalShutdown ?? setupSignalHandlers({
    inflightSpawns,
    runner: opts.runner,
    logger: opts.logger,
  });

  const queue = pendingTargets(opts.state);

  const start = async (target: string): Promise<void> => {
    await slots.acquire();
    if (runBudgetKilled || signalShutdown.killed()) {
      slots.release();
      return;
    }
    const p = runPipeline(
      {
        state: opts.state,
        runDir: opts.runDir,
        config: opts.config,
        runner: opts.runner,
        reporter: opts.reporter,
        clock: opts.clock,
        logger: opts.logger,
        cwd: opts.cwd,
        appProbe: opts.appProbe,
        onSpawn,
        onSpawnEnd,
        ...(opts.onProgress !== undefined && { onProgress: opts.onProgress }),
      },
      target,
    ).finally(() => {
      slots.release();
      saveState(opts.runDir, opts.state);
    });
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  };

  for (const target of queue) {
    if (runBudgetKilled || signalShutdown.killed()) break;
    await start(target);
  }
  try {
    await Promise.all([...inflight]);
  } finally {
    clearTimeout(runBudgetTimer);
    if (ownsSignals) signalShutdown.cleanup();
  }

  if (runBudgetKilled) {
    opts.state.terminations.push({
      kind: "run_budget",
      at: opts.clock.now().toISOString(),
      reason: `run wall-clock budget ${opts.config.budgets.run_seconds}s exceeded`,
    });
    saveState(opts.runDir, opts.state);
    return { exitCode: 4 };
  }

  if (signalShutdown.killed()) {
    const sig = signalShutdown.signal();
    const term: Termination = {
      kind: "user_interrupt",
      at: opts.clock.now().toISOString(),
      reason: `run interrupted by ${sig ?? "unknown"} signal`,
    };
    if (sig !== null) term.signal = sig;
    opts.state.terminations.push(term);
    saveState(opts.runDir, opts.state);
    return { exitCode: 6 };
  }

  return { exitCode: 0 };
}
