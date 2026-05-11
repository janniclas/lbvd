import * as fs from "node:fs";
import * as path from "node:path";
import type { Clock } from "../clock/clock.js";
import type { Redactor } from "../redaction/redact.js";
import { redact as defaultRedact } from "../redaction/redact.js";
import type { RunState, TargetState } from "../dispatcher/state.js";
import { validateFinding, type Finding } from "../stage1/schema.js";
import { validateOutcome, type Outcome } from "../stage2/schema.js";
import { route, type Tier, type Severity, type Priority } from "../routing/route.js";
import { validateAppProbe } from "../probe/schema.js";
import { sanitizeOneLine } from "../util/sanitize-text.js";

export interface ManifestOutcome {
  target_file: string;
  state: string;
  fingerprint: string | null;
  tier: 1 | 2 | 3 | null;
  severity_self_rated: Severity | null;
  confidence: number | null;
  priority: Priority | null;
  bump_reason: string | null;
  branch_url: string | null;
  issue_url: string | null;
  infra_issue_url: string | null;
  tracking_issue_url: string | null;
  error: string | null;
}

export interface TokenStats {
  per_file: { target: string; input: number; output: number }[];
  aggregates: { min: number; median: number; mean: number; p90: number; p95: number; max: number };
  histogram: {
    input: Record<string, number>;
    output: Record<string, number>;
  };
}

export interface ManifestAppProbe {
  startable: boolean;
  probe_narrative: string;
  probe_wall_seconds: number;
}

export interface Manifest {
  schema_version: 1;
  run_id: string;
  started_at: string;
  ended_at: string | null;
  total_files: number;
  concurrency: number;
  outcomes: ManifestOutcome[];
  counts_by_tier: { tier1: number; tier2: number; tier3: number; no_finding: number; failed: number };
  counts_by_outcome: Record<string, number>;
  severity_vs_tier_crosstab: Record<Severity, { tier1: number; tier2: number; tier3: number }>;
  severity_self_rated_distribution: Record<Severity, number>;
  confidence_histogram: number[];
  token_usage: {
    per_stage: { stage1: TokenStats; stage2: TokenStats };
    overall: TokenStats;
  };
  wall_clock_totals: { run_seconds: number; stage1_seconds: number; stage2_seconds: number };
  terminations: RunState["terminations"];
  errors: { target_file: string; error: string }[];
  app_probe: ManifestAppProbe | null;
}

interface PerTargetFiles {
  finding: Finding | null;
  outcome: Outcome | null;
}

function readJson(p: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readTargetSubtree(runDir: string, fingerprint: string | null): PerTargetFiles {
  if (fingerprint === null) return { finding: null, outcome: null };
  const subtree = path.join(runDir, "targets", fingerprint);
  let finding: Finding | null = null;
  let outcome: Outcome | null = null;
  const fp = path.join(subtree, "finding.json");
  if (fs.existsSync(fp)) {
    const raw = readJson(fp);
    if (raw !== null) {
      try {
        finding = validateFinding(raw);
      } catch {
        finding = null;
      }
    }
  }
  const op = path.join(subtree, "outcome.json");
  if (fs.existsSync(op)) {
    const raw = readJson(op);
    if (raw !== null) {
      try {
        outcome = validateOutcome(raw);
      } catch {
        outcome = null;
      }
    }
  }
  return { finding, outcome };
}

function buildOutcomeRow(target: string, t: TargetState, files: PerTargetFiles): ManifestOutcome {
  const sev = files.finding?.severity_self_rated ?? null;
  const tier = files.outcome?.tier ?? null;
  const rt = sev !== null && tier !== null ? route(tier as Tier, sev) : null;
  return {
    target_file: target,
    state: t.state,
    fingerprint: t.fingerprint,
    tier,
    severity_self_rated: sev,
    confidence: files.outcome?.confidence ?? null,
    priority: rt?.priority ?? null,
    bump_reason: rt?.bumpReason ?? null,
    branch_url: t.branch_url,
    issue_url: t.issue_url,
    infra_issue_url: t.infra_issue_url,
    tracking_issue_url: t.tracking_issue_url,
    error: t.error,
  };
}

function emptyTokenStats(): TokenStats {
  return {
    per_file: [],
    aggregates: { min: 0, median: 0, mean: 0, p90: 0, p95: 0, max: 0 },
    histogram: { input: {}, output: {} },
  };
}

const TOKEN_BUCKETS = [0, 1_000, 10_000, 100_000, 1_000_000, 10_000_000];

function bucketLabel(v: number): string {
  for (let i = TOKEN_BUCKETS.length - 1; i >= 0; i -= 1) {
    if (v >= TOKEN_BUCKETS[i]!) return `${TOKEN_BUCKETS[i]}+`;
  }
  return "0+";
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
  return sorted[idx]!;
}

function aggregate(values: number[]): TokenStats["aggregates"] {
  if (values.length === 0) {
    return { min: 0, median: 0, mean: 0, p90: 0, p95: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    min: sorted[0]!,
    median: percentile(sorted, 50),
    mean: sum / sorted.length,
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1]!,
  };
}

function buildTokenStats(per: { target: string; input: number; output: number }[]): TokenStats {
  const inputs = per.map((p) => p.input);
  const outputs = per.map((p) => p.output);
  const histogram = { input: {} as Record<string, number>, output: {} as Record<string, number> };
  for (const v of inputs) histogram.input[bucketLabel(v)] = (histogram.input[bucketLabel(v)] ?? 0) + 1;
  for (const v of outputs) histogram.output[bucketLabel(v)] = (histogram.output[bucketLabel(v)] ?? 0) + 1;
  return {
    per_file: per,
    aggregates: aggregate(inputs.concat(outputs)),
    histogram,
  };
}

function buildHistogramOf101(): number[] {
  return Array.from({ length: 101 }, () => 0);
}

interface BuildOpts {
  runDir: string;
  state: RunState;
  clock: Clock;
  redactor?: Redactor;
}

interface Accumulator {
  outcomes: ManifestOutcome[];
  perStage1: { target: string; input: number; output: number }[];
  perStage2: { target: string; input: number; output: number }[];
  countsByTier: Manifest["counts_by_tier"];
  countsByOutcome: Record<string, number>;
  crosstab: Manifest["severity_vs_tier_crosstab"];
  sevDist: Manifest["severity_self_rated_distribution"];
  confHist: number[];
  errors: Manifest["errors"];
}

function newAccumulator(): Accumulator {
  return {
    outcomes: [],
    perStage1: [],
    perStage2: [],
    countsByTier: { tier1: 0, tier2: 0, tier3: 0, no_finding: 0, failed: 0 },
    countsByOutcome: {},
    crosstab: {
      low: { tier1: 0, tier2: 0, tier3: 0 },
      medium: { tier1: 0, tier2: 0, tier3: 0 },
      high: { tier1: 0, tier2: 0, tier3: 0 },
    },
    sevDist: { low: 0, medium: 0, high: 0 },
    confHist: buildHistogramOf101(),
    errors: [],
  };
}

function tallyTier(tier: 1 | 2 | 3, c: Manifest["counts_by_tier"]): void {
  if (tier === 1) c.tier1 += 1;
  else if (tier === 2) c.tier2 += 1;
  else c.tier3 += 1;
}

function accumulate(acc: Accumulator, target: string, t: TargetState, files: PerTargetFiles): void {
  const row = buildOutcomeRow(target, t, files);
  acc.outcomes.push(row);
  acc.countsByOutcome[t.state] = (acc.countsByOutcome[t.state] ?? 0) + 1;
  if (t.error !== null) acc.errors.push({ target_file: target, error: t.error });
  if (t.state === "no_finding") acc.countsByTier.no_finding += 1;
  if (t.state === "failed") acc.countsByTier.failed += 1;
  if (files.finding !== null) {
    acc.perStage1.push({
      target,
      input: files.finding.stage1_token_usage.input,
      output: files.finding.stage1_token_usage.output,
    });
    if (files.finding.severity_self_rated !== undefined) {
      acc.sevDist[files.finding.severity_self_rated] += 1;
    }
  }
  if (files.outcome !== null) {
    acc.perStage2.push({
      target,
      input: files.outcome.stage2_token_usage.input,
      output: files.outcome.stage2_token_usage.output,
    });
    tallyTier(files.outcome.tier, acc.countsByTier);
    const cIdx = Math.max(0, Math.min(100, Math.round(files.outcome.confidence)));
    acc.confHist[cIdx] = (acc.confHist[cIdx] ?? 0) + 1;
    if (files.finding?.severity_self_rated !== undefined) {
      const sev = files.finding.severity_self_rated;
      const cell = files.outcome.tier === 1 ? "tier1" : files.outcome.tier === 2 ? "tier2" : "tier3";
      acc.crosstab[sev][cell] += 1;
    }
  }
}

function diffSeconds(startISO: string | null, endISO: string | null): number {
  if (startISO === null || endISO === null) return 0;
  const a = Date.parse(startISO);
  const b = Date.parse(endISO);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, (b - a) / 1000);
}

function targetStageSeconds(t: TargetState): { stage1: number; stage2: number } {
  // Stage 1 = stage1_started_at → stage2_started_at when stage 2 ran;
  // otherwise stage1_started_at → completed_at for terminal stage-1 outcomes.
  // Stage 2 = stage2_started_at → completed_at when both exist.
  let stage1 = 0;
  let stage2 = 0;
  if (t.stage1_started_at !== null) {
    if (t.stage2_started_at !== null) {
      stage1 = diffSeconds(t.stage1_started_at, t.stage2_started_at);
    } else if (t.completed_at !== null) {
      stage1 = diffSeconds(t.stage1_started_at, t.completed_at);
    }
  }
  if (t.stage2_started_at !== null && t.completed_at !== null) {
    stage2 = diffSeconds(t.stage2_started_at, t.completed_at);
  }
  return { stage1, stage2 };
}

function aggregateStageSeconds(state: RunState): { stage1: number; stage2: number } {
  let stage1 = 0;
  let stage2 = 0;
  for (const t of Object.values(state.targets)) {
    const s = targetStageSeconds(t);
    stage1 += s.stage1;
    stage2 += s.stage2;
  }
  return { stage1, stage2 };
}

function computeWallClock(state: RunState, clock: Clock): Manifest["wall_clock_totals"] {
  const start = Date.parse(state.started_at);
  const end = state.ended_at !== null ? Date.parse(state.ended_at) : clock.now().getTime();
  const stages = aggregateStageSeconds(state);
  return {
    run_seconds: Math.max(0, (end - start) / 1000),
    stage1_seconds: stages.stage1,
    stage2_seconds: stages.stage2,
  };
}

function readAppProbeForManifest(runDir: string, redact: (s: string) => string): ManifestAppProbe | null {
  const p = path.join(runDir, "app-probe.json");
  if (!fs.existsSync(p)) return null;
  const raw = readJson(p);
  if (raw === null) return null;
  try {
    const probe = validateAppProbe(raw);
    return {
      startable: probe.startable,
      // Agent-controlled string: redact known token literals and strip
      // ANSI / control chars before the value reaches manifest.json or
      // manifest.md (sec review M2).
      probe_narrative: redact(sanitizeOneLine(probe.probe_narrative, 2000)),
      probe_wall_seconds: probe.probe_wall_seconds,
    };
  } catch {
    return null;
  }
}

export function buildManifest(opts: BuildOpts): Manifest {
  const redact = opts.redactor?.redact ?? defaultRedact;
  const acc = newAccumulator();
  for (const [target, t] of Object.entries(opts.state.targets)) {
    const files = readTargetSubtree(opts.runDir, t.fingerprint);
    accumulate(acc, target, t, files);
  }
  const stage1Stats = buildTokenStats(acc.perStage1);
  const stage2Stats = buildTokenStats(acc.perStage2);
  const overall = buildTokenStats(acc.perStage1.concat(acc.perStage2));

  return {
    schema_version: 1,
    run_id: opts.state.run_id,
    started_at: opts.state.started_at,
    ended_at: opts.state.ended_at,
    total_files: Object.keys(opts.state.targets).length,
    concurrency: opts.state.config_snapshot.concurrency,
    outcomes: acc.outcomes,
    counts_by_tier: acc.countsByTier,
    counts_by_outcome: acc.countsByOutcome,
    severity_vs_tier_crosstab: acc.crosstab,
    severity_self_rated_distribution: acc.sevDist,
    confidence_histogram: acc.confHist,
    token_usage: { per_stage: { stage1: stage1Stats, stage2: stage2Stats }, overall },
    wall_clock_totals: computeWallClock(opts.state, opts.clock),
    terminations: opts.state.terminations,
    errors: acc.errors,
    app_probe: readAppProbeForManifest(opts.runDir, redact),
  };
}

export { emptyTokenStats };
