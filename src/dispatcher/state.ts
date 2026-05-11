import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "../config/defaults.js";
import { isValidFingerprint, isValidRunId } from "../util/safe-path.js";
import { compileValidator, runValidator, AjvValidationError } from "../util/ajv.js";

export type TargetStateName =
  | "queued"
  | "stage1_running"
  | "stage2_running"
  | "stage2_done"
  | "reporting_branch"
  | "reporting_issue"
  | "reporting_infra"
  | "reporting_tracking"
  | "done"
  | "failed"
  | "no_finding"
  | "skipped_dup";

export const TERMINAL_STATES: ReadonlySet<TargetStateName> = new Set([
  "done",
  "failed",
  "no_finding",
  "skipped_dup",
]);

export interface TargetState {
  state: TargetStateName;
  fingerprint: string | null;
  branch_url: string | null;
  issue_url: string | null;
  infra_issue_url: string | null;
  tracking_issue_url: string | null;
  error: string | null;
  stage1_started_at: string | null;
  stage2_started_at: string | null;
  completed_at: string | null;
}

export interface Termination {
  kind: "run_budget" | "user_interrupt";
  at: string;
  reason: string;
  signal?: "SIGINT" | "SIGTERM";
}

export type AppProbeStateName = "pending" | "running" | "done";

export interface AppProbeState {
  state: AppProbeStateName;
  startable: boolean | null;
  completed_at: string | null;
}

export const APP_PROBE_DEFAULT: AppProbeState = {
  state: "pending",
  startable: null,
  completed_at: null,
};

export interface RunState {
  schema_version: 1;
  run_id: string;
  config_snapshot: ResolvedConfig;
  started_at: string;
  ended_at: string | null;
  targets: Record<string, TargetState>;
  terminations: Termination[];
  app_probe?: AppProbeState;
}

export function ensureRunDir(cwd: string, runId: string): string {
  const dir = path.join(cwd, ".lbvd", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "targets"), { recursive: true });
  return dir;
}

export function statePath(runDir: string): string {
  return path.join(runDir, "state.json");
}

interface InitOpts {
  runId: string;
  config: ResolvedConfig;
  startedAt: string;
  targets: Record<string, TargetState>;
}

export function initState(opts: InitOpts): RunState {
  return {
    schema_version: 1,
    run_id: opts.runId,
    config_snapshot: opts.config,
    started_at: opts.startedAt,
    ended_at: null,
    targets: opts.targets,
    terminations: [],
  };
}

export class StateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateValidationError";
  }
}

const STATE_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "state.schema.json",
);

const stateSchema = JSON.parse(fs.readFileSync(STATE_SCHEMA_PATH, "utf8")) as object;
const compiledState = compileValidator<RunState>(stateSchema);

const KNOWN_STATES: ReadonlySet<TargetStateName> = new Set([
  "queued",
  "stage1_running",
  "stage2_running",
  "stage2_done",
  "reporting_branch",
  "reporting_issue",
  "reporting_infra",
  "reporting_tracking",
  "done",
  "failed",
  "no_finding",
  "skipped_dup",
]);

const URL_RE = /^(https?|file):\/\//;

function reassertUrl(label: string, v: string | null): void {
  if (v === null) return;
  if (!URL_RE.test(v)) {
    throw new StateValidationError(`state.json: ${label} must use http(s)/file scheme: '${v}'`);
  }
}

export function validateRunState(parsed: RunState): void {
  try {
    runValidator(compiledState, parsed, "state.json");
  } catch (e) {
    if (e instanceof AjvValidationError) {
      throw new StateValidationError(e.message);
    }
    throw e;
  }
  // Belt-and-suspenders: redundant with the schema, but kept so that future
  // schema loosening cannot regress these security-critical checks. Covers
  // run_id format, fingerprint format, target.state enum, and URL prefix
  // discipline (security review H3).
  if (!isValidRunId(parsed.run_id)) {
    throw new StateValidationError(`state.json: run_id format invalid`);
  }
  for (const [k, t] of Object.entries(parsed.targets)) {
    if (t.fingerprint !== null && !isValidFingerprint(t.fingerprint)) {
      throw new StateValidationError(`state.json: target '${k}' fingerprint not 12-hex`);
    }
    if (!KNOWN_STATES.has(t.state)) {
      throw new StateValidationError(`state.json: target '${k}' has unknown state '${t.state}'`);
    }
    reassertUrl(`targets[${k}].branch_url`, t.branch_url);
    reassertUrl(`targets[${k}].issue_url`, t.issue_url);
    reassertUrl(`targets[${k}].infra_issue_url`, t.infra_issue_url);
    reassertUrl(`targets[${k}].tracking_issue_url`, t.tracking_issue_url);
  }
}

export function loadState(runDir: string): RunState {
  const raw = fs.readFileSync(statePath(runDir), "utf8");
  const parsed = JSON.parse(raw) as RunState;
  validateRunState(parsed);
  return parsed;
}

/**
 * Return the current `app_probe` record, defaulting an absent field to
 * `{ state: "pending", startable: null, completed_at: null }`. Per
 * architecture §22.9 the field is forward-compatibly added to `state.json`;
 * a pre-FR-17 snapshot resumed under FR-17 must re-run the probe.
 */
export function getAppProbeState(state: RunState): AppProbeState {
  return state.app_probe ?? { ...APP_PROBE_DEFAULT };
}

export function setAppProbeState(state: RunState, next: AppProbeState): void {
  state.app_probe = next;
}

export function saveState(runDir: string, state: RunState): void {
  atomicWriteJson(statePath(runDir), state);
}

export function atomicWriteJson(p: string, data: unknown): void {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const rand = crypto.randomBytes(4).toString("hex");
  const tmp = `${p}.tmp.${process.pid}.${rand}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

export function transitionTarget(
  state: RunState,
  target: string,
  next: TargetStateName,
): void {
  const cur = state.targets[target];
  if (cur === undefined) {
    throw new Error(`transitionTarget: unknown target ${target}`);
  }
  if (TERMINAL_STATES.has(cur.state)) {
    return;
  }
  cur.state = next;
}

export function setTargetField<K extends keyof TargetState>(
  state: RunState,
  target: string,
  key: K,
  value: TargetState[K],
): void {
  const cur = state.targets[target];
  if (cur === undefined) {
    throw new Error(`setTargetField: unknown target ${target}`);
  }
  cur[key] = value;
}
