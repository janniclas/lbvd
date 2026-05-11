import * as fs from "node:fs";
import * as path from "node:path";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../log/log.js";
import type { ResolvedConfig } from "../config/defaults.js";
import type { Runner } from "../runner/interface.js";
import { buildAgentEnv } from "../runner/safe-env.js";
import type { Finding } from "../stage1/schema.js";
import type { AppProbeContext, AppLockHandle } from "../runner/interface.js";
import { validateOutcome, type Outcome } from "./schema.js";
import {
  applyAppNotStartableDowngrade,
  syntheticBudgetKillOutcome,
  validateAndFix,
} from "./tier-validate.js";

export interface Stage2Opts {
  finding: Finding;
  runDir: string;
  targetSubtree: string;
  repoRoot: string;
  config: ResolvedConfig;
  runner: Runner;
  clock: Clock;
  logger: Logger;
  /**
   * FR-17: app-probe context passed through to the Stage 2 agent. When
   * the probe declared `startable: false` (or `null`), the dispatcher
   * applies an after-the-fact Tier 1 → Tier 2 downgrade.
   */
  appProbe?: AppProbeContext | null;
  appLock?: AppLockHandle | null;
  onSpawn?: (h: { pid: number }) => void;
  onSpawnEnd?: (h: { pid: number }) => void;
}

export type Stage2Result =
  | { kind: "ok"; outcome: Outcome }
  | { kind: "failed"; error: string };

function readJson(p: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function cleanupBudgetKillArtifacts(targetSubtree: string): void {
  for (const f of fs.readdirSync(targetSubtree)) {
    if (!(f.startsWith("exploit.") || f.startsWith("unit-test."))) continue;
    const full = path.join(targetSubtree, f);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // An agent that planted a directory before budget kill: remove it
      // recursively, but only after re-confirming it stays inside the
      // targetSubtree (defense-in-depth against symlinked-prefix swaps).
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch {
        // Last-ditch best-effort; the next resume's reconcile sweep will
        // catch any survivors.
      }
      continue;
    }
    fs.rmSync(full, { force: true });
  }
}

function writeOutcome(targetSubtree: string, outcome: Outcome): void {
  fs.writeFileSync(path.join(targetSubtree, "outcome.json"), JSON.stringify(outcome, null, 2));
}

/**
 * FR-17: if the app probe declared the application unstartable — OR if
 * the probe phase could not establish startability at all (probe crash,
 * absent context) — any Tier 1 outcome the agent produced is downgraded
 * to Tier 2 with `downgrade_reason: "app_not_startable"`. Mirrors
 * architecture §22.6 / decision 31: the probe result must be a
 * falsifiable input to Tier 1 validation, not advisory. Absence of
 * evidence takes the safe direction (sec review M1).
 */
function maybeAppNotStartable(outcome: Outcome, ctx: AppProbeContext | null | undefined): Outcome {
  if (ctx === null || ctx === undefined) return applyAppNotStartableDowngrade(outcome);
  if (ctx.startable) return outcome;
  return applyAppNotStartableDowngrade(outcome);
}

function readAndValidateOutcome(targetSubtree: string): Outcome | null {
  const outcomePath = path.join(targetSubtree, "outcome.json");
  if (!fs.existsSync(outcomePath)) return null;
  const raw = readJson(outcomePath);
  if (raw === null) return null;
  return validateAndFix({ outcome: validateOutcome(raw), targetSubtree });
}

interface BudgetTimer {
  fired: { value: boolean };
  cancel: () => void;
}

function armBudget(opts: Stage2Opts, pidPromise: Promise<number>): BudgetTimer {
  const fired = { value: false };
  const ms = opts.config.budgets.stage2_per_finding_seconds * 1000;
  const handle = setTimeout(async () => {
    fired.value = true;
    const pid = await pidPromise;
    void opts.runner.abort(pid, 5000);
  }, ms);
  return { fired, cancel: () => clearTimeout(handle) };
}

export async function invokeStage2(opts: Stage2Opts): Promise<Stage2Result> {
  let resolvePid: (n: number) => void;
  const pidPromise = new Promise<number>((r) => {
    resolvePid = r;
  });
  const budget = armBudget(opts, pidPromise);
  const startMono = opts.clock.monotonicMs();

  let spawnedPid = -1;
  try {
    const spawned = await opts.runner.spawn({
      runDir: opts.runDir,
      targetSubtree: opts.targetSubtree,
      targetFile: opts.finding.target_file,
      repoRoot: opts.repoRoot,
      stage: 2,
      capabilities: ["fs:read", "fs:write", "fs:write:targetSubtree", "net", "shell"],
      finding: opts.finding,
      appProbe: opts.appProbe ?? null,
      appLock: opts.appLock ?? null,
      budgetSeconds: opts.config.budgets.stage2_per_finding_seconds,
      redactedEnv: buildAgentEnv({
        config: opts.config,
        env: process.env,
        extra: { LBVD_REPO_ROOT: opts.repoRoot },
      }),
      logger: opts.logger,
    });
    spawnedPid = spawned.pid;
    resolvePid!(spawned.pid);
    const handle = { pid: spawned.pid };
    opts.onSpawn?.(handle);
    let exitCode = -1;
    try {
      const exit = await spawned.done;
      exitCode = exit.code;
    } finally {
      opts.onSpawnEnd?.(handle);
    }
    budget.cancel();

    // Race fix (security review M3): if the timer fired but the child still
    // exited cleanly with a valid outcome.json, treat the run as successful.
    // The kill landed on an already-exited process; the agent's work stands.
    const racedOutcome =
      budget.fired.value && exitCode === 0 ? readAndValidateOutcome(opts.targetSubtree) : null;
    if (budget.fired.value && racedOutcome === null) {
      cleanupBudgetKillArtifacts(opts.targetSubtree);
      const synth = syntheticBudgetKillOutcome(
        opts.finding.fingerprint,
        (opts.clock.monotonicMs() - startMono) / 1000,
      );
      writeOutcome(opts.targetSubtree, synth);
      return { kind: "ok", outcome: synth };
    }
    if (racedOutcome !== null) {
      const finalRaced = maybeAppNotStartable(racedOutcome, opts.appProbe);
      writeOutcome(opts.targetSubtree, finalRaced);
      return { kind: "ok", outcome: finalRaced };
    }
    if (exitCode !== 0) {
      return { kind: "failed", error: `stage2 exited with code ${exitCode}` };
    }
    const outcome = readAndValidateOutcome(opts.targetSubtree);
    if (outcome === null) {
      return { kind: "failed", error: "stage2 produced no/invalid outcome.json" };
    }
    const finalOutcome = maybeAppNotStartable(outcome, opts.appProbe);
    writeOutcome(opts.targetSubtree, finalOutcome);
    return { kind: "ok", outcome: finalOutcome };
  } catch (e) {
    budget.cancel();
    void spawnedPid;
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: "failed", error: msg };
  }
}
