import type { TargetStateName } from "../dispatcher/state.js";
import type { Redactor } from "../redaction/redact.js";
import { redact as defaultRedact } from "../redaction/redact.js";
import { sanitizeOneLine } from "../util/sanitize-text.js";

export interface ProgressReporter {
  status(msg: string): void;
  stop(): void;
}

export interface StageCounts {
  total: number;
  scanning: number;
  exploiting: number;
  reporting: number;
  completed: number;
  failed: number;
}

type ActiveGroup = "scanning" | "exploiting" | "reporting" | "completed" | "failed";

function classifyState(s: TargetStateName): ActiveGroup | null {
  switch (s) {
    case "stage1_running":
      return "scanning";
    case "stage2_running":
    case "stage2_done":
      return "exploiting";
    case "reporting_branch":
    case "reporting_issue":
    case "reporting_infra":
    case "reporting_tracking":
      return "reporting";
    case "done":
    case "no_finding":
    case "skipped_dup":
      return "completed";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

export function countStages(
  targets: Record<string, { state: TargetStateName }>,
): StageCounts {
  const c: StageCounts = {
    total: 0,
    scanning: 0,
    exploiting: 0,
    reporting: 0,
    completed: 0,
    failed: 0,
  };
  for (const { state } of Object.values(targets)) {
    c.total++;
    const group = classifyState(state);
    if (group !== null) c[group]++;
  }
  return c;
}

function fillBar(finished: number, total: number, width: number): string {
  if (total === 0) return "░".repeat(width);
  const n = Math.min(width, Math.round((finished / total) * width));
  return "█".repeat(n) + "░".repeat(width - n);
}

export function renderProgressLine(
  targets: Record<string, { state: TargetStateName }>,
  cols: number,
): string {
  const c = countStages(targets);
  const finished = c.completed + c.failed;
  const segments: string[] = [
    `[${fillBar(finished, c.total, 20)}]`,
    `${finished}/${c.total}`,
  ];
  if (c.scanning > 0) segments.push(`stage1: ${c.scanning}`);
  if (c.exploiting > 0) segments.push(`stage2: ${c.exploiting}`);
  if (c.reporting > 0) segments.push(`reporting: ${c.reporting}`);
  if (c.failed > 0) segments.push(`failed: ${c.failed}`);
  const line = segments.join("  ");
  return line.length <= cols ? line : line.slice(0, cols);
}

export function makeProgressReporter(
  getTargets: () => Record<string, { state: TargetStateName }>,
  redactor?: Redactor,
): ProgressReporter {
  if (!process.stderr.isTTY) return { status() {}, stop() {} };

  const applyRedact = redactor !== undefined
    ? (s: string) => redactor.redact(s)
    : defaultRedact;

  let lastBarLen = 0;

  function renderBar(): void {
    const cols = (process.stderr.columns ?? 80) - 1;
    const bar = renderProgressLine(getTargets(), cols);
    const padding = lastBarLen > bar.length ? " ".repeat(lastBarLen - bar.length) : "";
    process.stderr.write(`\r${bar}${padding}`);
    lastBarLen = bar.length;
  }

  function printStatus(msg: string): void {
    const cols = (process.stderr.columns ?? 80) - 1;
    const clearLine = " ".repeat(lastBarLen);
    // Defense-in-depth: status messages may carry agent-controlled
    // fields (file names, narrative excerpts, probe failure reasons).
    // The call sites already strip ANSI/newlines via sanitizeOneLine,
    // but apply it again here so any future call site that forgets
    // cannot scribble control bytes into the operator's terminal.
    // Sec review (probe-logging) H1.
    const safeMsg = sanitizeOneLine(applyRedact(msg), cols);
    process.stderr.write(`\r${clearLine}\r${safeMsg}\n`);
    lastBarLen = 0;
    renderBar();
  }

  renderBar();
  const timer = setInterval(renderBar, 250);
  timer.unref();

  return {
    status(msg: string): void {
      printStatus(msg);
    },
    stop(): void {
      clearInterval(timer);
      if (lastBarLen > 0) {
        process.stderr.write(`\r${" ".repeat(lastBarLen)}\r`);
      }
    },
  };
}
