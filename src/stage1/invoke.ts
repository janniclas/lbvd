import * as fs from "node:fs";
import * as path from "node:path";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../log/log.js";
import type { ResolvedConfig } from "../config/defaults.js";
import type { Runner } from "../runner/interface.js";
import { buildAgentEnv } from "../runner/safe-env.js";
import { validateFinding, type Finding } from "./schema.js";

export interface Stage1Opts {
  targetFile: string;
  runDir: string;
  pendingSubtree: string;
  repoRoot: string;
  config: ResolvedConfig;
  runner: Runner;
  clock: Clock;
  logger: Logger;
  budgetSeconds: number;
  onSpawn?: (h: { pid: number }) => void;
  onSpawnEnd?: (h: { pid: number }) => void;
}

export type Stage1Result =
  | { kind: "vulnerability"; finding: Finding }
  | { kind: "no_finding"; finding: Finding }
  | { kind: "failed"; error: string };

interface BudgetTimer {
  fired: { value: boolean };
  cancel: () => void;
}

function armStage1Budget(opts: Stage1Opts, pidPromise: Promise<number>): BudgetTimer {
  const fired = { value: false };
  const ms = opts.config.budgets.stage1_per_finding_seconds * 1000;
  const handle = setTimeout(async () => {
    fired.value = true;
    const pid = await pidPromise;
    void opts.runner.abort(pid, 5000);
  }, ms);
  return { fired, cancel: () => clearTimeout(handle) };
}

function readJson(p: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function classifyFinding(finding: Finding): Stage1Result {
  return finding.status === "vulnerability"
    ? { kind: "vulnerability", finding }
    : { kind: "no_finding", finding };
}

function hasValidFinding(pendingSubtree: string): boolean {
  const findingPath = path.join(pendingSubtree, "finding.json");
  if (!fs.existsSync(findingPath)) return false;
  const raw = readJson(findingPath);
  if (raw === null) return false;
  try {
    validateFinding(raw);
    return true;
  } catch {
    return false;
  }
}

function readAndValidate(pendingSubtree: string): Stage1Result {
  const findingPath = path.join(pendingSubtree, "finding.json");
  if (!fs.existsSync(findingPath)) {
    return { kind: "failed", error: "stage1 produced no finding.json" };
  }
  const raw = readJson(findingPath);
  if (raw === null) {
    return { kind: "failed", error: "stage1 finding.json is malformed JSON" };
  }
  try {
    return classifyFinding(validateFinding(raw));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: "failed", error: `stage1 finding.json invalid: ${msg}` };
  }
}

export async function invokeStage1(opts: Stage1Opts): Promise<Stage1Result> {
  fs.mkdirSync(opts.pendingSubtree, { recursive: true });
  let resolvePid: (n: number) => void;
  const pidPromise = new Promise<number>((r) => {
    resolvePid = r;
  });
  const budget = armStage1Budget(opts, pidPromise);
  try {
    const spawned = await opts.runner.spawn({
      runDir: opts.runDir,
      targetSubtree: opts.pendingSubtree,
      targetFile: opts.targetFile,
      repoRoot: opts.repoRoot,
      stage: 1,
      capabilities: ["fs:read", "fs:write:targetSubtree"],
      scanScope: opts.config.scan.scope,
      budgetSeconds: opts.budgetSeconds,
      redactedEnv: buildAgentEnv({ config: opts.config, env: process.env }),
      logger: opts.logger,
    });
    resolvePid!(spawned.pid);
    const handle = { pid: spawned.pid };
    opts.onSpawn?.(handle);
    try {
      const exit = await spawned.done;
      // Race fix (security review M3): if the budget timer fired but the
      // child still exited cleanly (race between setTimeout and child exit),
      // and a valid finding.json is present, treat the run as successful —
      // the kill landed on an already-exited process and was a no-op.
      if (budget.fired.value && (exit.code !== 0 || !hasValidFinding(opts.pendingSubtree))) {
        return {
          kind: "failed",
          error: `stage1 exceeded ${opts.config.budgets.stage1_per_finding_seconds}s budget`,
        };
      }
      if (exit.code !== 0) {
        return { kind: "failed", error: `stage1 exited with code ${exit.code}` };
      }
      return readAndValidate(opts.pendingSubtree);
    } finally {
      opts.onSpawnEnd?.(handle);
    }
  } finally {
    budget.cancel();
  }
}
