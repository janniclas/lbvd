import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../log/log.js";
import type { ResolvedConfig } from "../config/defaults.js";
import type { Runner } from "../runner/interface.js";
import type { Reporter, BranchSpec, IssueSpec } from "../reporter/interface.js";
import type { RunState, TargetState } from "./state.js";
import { saveState } from "./state.js";
import { invokeStage1 } from "../stage1/invoke.js";
import { invokeStage2 } from "../stage2/invoke.js";
import { route } from "../routing/route.js";
import { branchName } from "../reporter/branch-name.js";
import {
  findingMarker,
  infraMarker,
  renderFindingIssueBody,
  renderInfraIssueBody,
  renderTrackingIssueBody,
} from "../reporter/issue-body.js";
import { confineToParent, isValidFingerprint, PathBoundaryError } from "../util/safe-path.js";
import { sanitizeOneLine } from "../util/sanitize-text.js";
import type { Finding } from "../stage1/schema.js";
import type { Outcome } from "../stage2/schema.js";
import type { ProgressReporter } from "../progress/bar.js";
import type { AppProbe } from "../probe/schema.js";
import { toStage2Context } from "./probe-phase.js";

export interface SpawnHandle {
  pid: number;
}

export interface PipelineDeps {
  state: RunState;
  runDir: string;
  config: ResolvedConfig;
  runner: Runner;
  reporter: Reporter;
  clock: Clock;
  logger: Logger;
  cwd: string;
  appProbe: AppProbe | null;
  onSpawn?: (h: SpawnHandle) => void;
  onSpawnEnd?: (h: SpawnHandle) => void;
  onProgress?: ProgressReporter;
}

interface Ctx extends PipelineDeps {
  target: string;
}

function pendingDirFor(runDir: string, target: string): string {
  const sha1 = crypto.createHash("sha1").update(target).digest("hex").slice(0, 12);
  return path.join(runDir, "targets", "_pending", sha1);
}

function targetSubtree(runDir: string, fingerprint: string): string {
  return path.join(runDir, "targets", fingerprint);
}

function setState(ctx: Ctx, next: TargetState["state"]): void {
  const t = ctx.state.targets[ctx.target]!;
  t.state = next;
  saveState(ctx.runDir, ctx.state);
}

function setField<K extends keyof TargetState>(ctx: Ctx, key: K, value: TargetState[K]): void {
  const t = ctx.state.targets[ctx.target]!;
  t[key] = value;
  saveState(ctx.runDir, ctx.state);
}

async function runStage1(ctx: Ctx): Promise<{ finding: Finding } | "no_finding" | "failed"> {
  const pending = pendingDirFor(ctx.runDir, ctx.target);
  setField(ctx, "stage1_started_at", ctx.clock.now().toISOString());
  setState(ctx, "stage1_running");
  ctx.onProgress?.status(`Scanning ${path.basename(ctx.target)}`);
  const result = await invokeStage1({
    targetFile: ctx.target,
    runDir: ctx.runDir,
    pendingSubtree: pending,
    repoRoot: ctx.cwd,
    config: ctx.config,
    runner: ctx.runner,
    clock: ctx.clock,
    logger: ctx.logger,
    budgetSeconds: ctx.config.budgets.stage2_per_finding_seconds,
    ...(ctx.onSpawn !== undefined && { onSpawn: ctx.onSpawn }),
    ...(ctx.onSpawnEnd !== undefined && { onSpawnEnd: ctx.onSpawnEnd }),
  });
  if (result.kind === "failed") {
    setField(ctx, "error", result.error);
    setField(ctx, "completed_at", ctx.clock.now().toISOString());
    setState(ctx, "failed");
    ctx.logger.info("target.terminal", { target: ctx.target, state: "failed", error: result.error });
    ctx.onProgress?.status(`Failed: ${path.basename(ctx.target)}`);
    return "failed";
  }
  if (result.kind === "no_finding") {
    setField(ctx, "fingerprint", result.finding.fingerprint);
    setField(ctx, "completed_at", ctx.clock.now().toISOString());
    setState(ctx, "no_finding");
    ctx.logger.info("target.terminal", { target: ctx.target, state: "no_finding" });
    ctx.onProgress?.status(`Clean: ${path.basename(ctx.target)}`);
    return "no_finding";
  }
  // vulnerability: rename pending→<fingerprint>
  const finalDir = targetSubtree(ctx.runDir, result.finding.fingerprint);
  if (!fs.existsSync(finalDir)) {
    fs.renameSync(pending, finalDir);
  }
  setField(ctx, "fingerprint", result.finding.fingerprint);
  return { finding: result.finding };
}

async function runStage2(ctx: Ctx, finding: Finding): Promise<Outcome | null> {
  setField(ctx, "stage2_started_at", ctx.clock.now().toISOString());
  setState(ctx, "stage2_running");
  ctx.onProgress?.status(`Testing vulnerability in ${path.basename(ctx.target)}`);
  const probeCtx = toStage2Context(ctx.appProbe);
  const result = await invokeStage2({
    finding,
    runDir: ctx.runDir,
    targetSubtree: targetSubtree(ctx.runDir, finding.fingerprint),
    repoRoot: ctx.cwd,
    config: ctx.config,
    runner: ctx.runner,
    clock: ctx.clock,
    logger: ctx.logger,
    appProbe: probeCtx,
    appLock: probeCtx !== null && probeCtx.startable
      ? {
          mutexTimeoutMs: ctx.config.budgets.app_mutex_timeout_seconds * 1000,
          stage2BudgetMs: ctx.config.budgets.stage2_per_finding_seconds * 1000,
        }
      : null,
    ...(ctx.onSpawn !== undefined && { onSpawn: ctx.onSpawn }),
    ...(ctx.onSpawnEnd !== undefined && { onSpawnEnd: ctx.onSpawnEnd }),
  });
  if (result.kind === "failed") {
    setField(ctx, "error", result.error);
    setField(ctx, "completed_at", ctx.clock.now().toISOString());
    setState(ctx, "failed");
    ctx.logger.info("target.terminal", { target: ctx.target, state: "failed", error: result.error });
    ctx.onProgress?.status(`Failed: ${path.basename(ctx.target)}`);
    return null;
  }
  setState(ctx, "stage2_done");
  return result.outcome;
}

function readArtifactConfined(subtree: string, relPath: string): string | null {
  try {
    const abs = confineToParent({ parent: subtree, candidate: relPath, mustExist: true });
    return fs.readFileSync(abs, "utf8");
  } catch (e) {
    if (e instanceof PathBoundaryError) return null;
    throw e;
  }
}

function buildBranchSpec(
  finding: Finding,
  outcome: Outcome,
  config: ResolvedConfig,
  subtree: string,
): BranchSpec {
  if (outcome.tier !== 1 && outcome.tier !== 2) {
    throw new Error(`buildBranchSpec called with non-branchable tier ${outcome.tier}`);
  }
  const tier = outcome.tier;
  const name = branchName(tier, finding.fingerprint);
  const files: { path: string; content: string }[] = [];
  files.push({ path: "LBVD_FINDING.md", content: sanitizeForBody(finding.narrative ?? "(no narrative)") });
  if (outcome.exploit_artifact_path !== null) {
    const content = readArtifactConfined(subtree, outcome.exploit_artifact_path);
    if (content !== null) {
      files.push({ path: outcome.exploit_artifact_path, content });
    }
  }
  if (outcome.test_artifact_path !== null) {
    const content = readArtifactConfined(subtree, outcome.test_artifact_path);
    if (content !== null) {
      files.push({ path: outcome.test_artifact_path, content });
    }
  }
  files.push({ path: "REPRODUCE.md", content: "Run the included artifact from this branch.\n" });
  return {
    name,
    baseBranch: config.vcs.default_branch,
    files,
    commitMessage: `lbvd: ${sanitizeOneLine(finding.category)} (${finding.fingerprint})`,
    targetRepo: config.vcs.exploit_target_repo.length > 0 ? "exploit_target" : "source",
  };
}

function sanitizeForBody(s: string): string {
  return s.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
}


async function reportBranch(ctx: Ctx, finding: Finding, outcome: Outcome): Promise<string> {
  setState(ctx, "reporting_branch");
  const subtree = targetSubtree(ctx.runDir, finding.fingerprint);
  const spec = buildBranchSpec(finding, outcome, ctx.config, subtree);
  const existing = await ctx.reporter.findBranch(spec.name, spec.targetRepo);
  let url: string;
  if (existing !== null) {
    url = existing.url;
  } else {
    url = (await ctx.reporter.pushBranch(spec)).url;
  }
  setField(ctx, "branch_url", url);
  return url;
}

async function reportFindingIssue(ctx: Ctx, finding: Finding, outcome: Outcome): Promise<string> {
  setState(ctx, "reporting_issue");
  const routing = route(outcome.tier, finding.severity_self_rated ?? "low");
  const repoSel = ctx.config.vcs.exploit_target_repo.length > 0 ? "exploit_target" : "source";
  const marker = findingMarker(finding.fingerprint);
  const existing = await ctx.reporter.findIssueByMarker(marker, repoSel);
  if (existing !== null && existing.state === "open") {
    setField(ctx, "issue_url", existing.url);
    return existing.url;
  }
  const body = renderFindingIssueBody({
    finding,
    outcome,
    routing,
    branchUrl: ctx.state.targets[ctx.target]!.branch_url,
    runId: ctx.state.run_id,
  });
  const spec: IssueSpec = {
    kind: "finding",
    title: `[lbvd] ${finding.category} (${finding.fingerprint})`,
    body,
    labels: [`lbvd`, `priority:${routing.priority}`, `tier:${outcome.tier}`],
    targetRepo: repoSel,
  };
  const opened = await ctx.reporter.openIssue(spec);
  setField(ctx, "issue_url", opened.url);
  return opened.url;
}

async function reportInfraIssue(ctx: Ctx, finding: Finding, outcome: Outcome): Promise<void> {
  setState(ctx, "reporting_infra");
  const repoSel = ctx.config.vcs.exploit_target_repo.length > 0 ? "exploit_target" : "source";
  const marker = infraMarker(finding.fingerprint);
  const existing = await ctx.reporter.findIssueByMarker(marker, repoSel);
  if (existing !== null && existing.state === "open") {
    setField(ctx, "infra_issue_url", existing.url);
    return;
  }
  const body = renderInfraIssueBody({ finding, outcome, runId: ctx.state.run_id });
  const opened = await ctx.reporter.openIssue({
    kind: "infra",
    title: `[lbvd][infra] ${finding.category} (${finding.fingerprint})`,
    body,
    labels: ["lbvd", "lbvd:infra"],
    targetRepo: repoSel,
  });
  setField(ctx, "infra_issue_url", opened.url);
}

async function reportTrackingIssue(ctx: Ctx, finding: Finding, findingIssueUrl: string): Promise<void> {
  setState(ctx, "reporting_tracking");
  if (ctx.state.targets[ctx.target]!.tracking_issue_url !== null) return;
  const body = renderTrackingIssueBody({ findingIssueUrl, finding, runId: ctx.state.run_id });
  const opened = await ctx.reporter.openIssue({
    kind: "tracking",
    title: `[lbvd] ${finding.category} (${finding.fingerprint})`,
    body,
    labels: ["lbvd"],
    targetRepo: "source",
  });
  setField(ctx, "tracking_issue_url", opened.url);
}

async function reportPhase(ctx: Ctx, finding: Finding, outcome: Outcome): Promise<void> {
  ctx.onProgress?.status(`Reporting: ${path.basename(ctx.target)}`);
  const routing = route(outcome.tier, finding.severity_self_rated ?? "low");
  if (routing.branch) {
    await reportBranch(ctx, finding, outcome);
  }
  const findingIssueUrl = await reportFindingIssue(ctx, finding, outcome);
  if (outcome.infra_requirements !== null) {
    await reportInfraIssue(ctx, finding, outcome);
  }
  if (ctx.config.vcs.exploit_target_repo.length > 0) {
    await reportTrackingIssue(ctx, finding, findingIssueUrl);
  }
  setField(ctx, "completed_at", ctx.clock.now().toISOString());
  setState(ctx, "done");
  ctx.logger.info("target.terminal", { target: ctx.target, state: "done" });
  ctx.onProgress?.status(`Vulnerability confirmed: ${sanitizeOneLine(finding.category)} in ${path.basename(ctx.target)}`);
}

export async function runPipeline(deps: PipelineDeps, target: string): Promise<void> {
  const ctx: Ctx = { ...deps, target };
  try {
    const t = ctx.state.targets[target]!;
    let finding: Finding | null = null;
    if (t.state === "queued") {
      const r = await runStage1(ctx);
      if (r === "failed" || r === "no_finding") return;
      finding = r.finding;
    } else if (isValidFingerprint(t.fingerprint)) {
      // resume path: load finding.json from subtree
      const subtree = targetSubtree(ctx.runDir, t.fingerprint);
      const findingPath = path.join(subtree, "finding.json");
      if (fs.existsSync(findingPath)) {
        const { validateFinding } = await import("../stage1/schema.js");
        finding = validateFinding(JSON.parse(fs.readFileSync(findingPath, "utf8")));
      }
    }
    if (finding === null) {
      setField(ctx, "error", "pipeline: no finding available to drive stage 2 / reporter");
      setField(ctx, "completed_at", ctx.clock.now().toISOString());
      setState(ctx, "failed");
      return;
    }

    let outcome: Outcome | null = null;
    const subtree = targetSubtree(ctx.runDir, finding.fingerprint);
    const outcomePath = path.join(subtree, "outcome.json");
    if (
      t.state === "stage2_done" ||
      t.state === "reporting_branch" ||
      t.state === "reporting_issue" ||
      t.state === "reporting_infra" ||
      t.state === "reporting_tracking"
    ) {
      if (fs.existsSync(outcomePath)) {
        const { validateOutcome } = await import("../stage2/schema.js");
        outcome = validateOutcome(JSON.parse(fs.readFileSync(outcomePath, "utf8")));
      }
    }
    if (outcome === null) {
      const r = await runStage2(ctx, finding);
      if (r === null) return;
      outcome = r;
    }
    await reportPhase(ctx, finding, outcome);
  } catch (e) {
    const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
    setField(ctx, "error", msg);
    setField(ctx, "completed_at", ctx.clock.now().toISOString());
    setState(ctx, "failed");
    ctx.logger.info("target.crashed", { target, error: msg });
    ctx.onProgress?.status(`Failed: ${path.basename(target)}`);
  }
}
