import type { ResolvedConfig } from "../config/defaults.js";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../log/log.js";
import type { Redactor } from "../redaction/redact.js";
import { runDispatcher } from "./run.js";

export interface RunScanOpts {
  config: ResolvedConfig;
  clock: Clock;
  runId: string;
  mode: "scan-all" | "scan-changes" | "resume";
  cwd: string;
  logger: Logger;
  redactor?: Redactor;
}

export interface RunScanResult {
  exitCode: number;
}

export async function runScan(opts: RunScanOpts): Promise<RunScanResult> {
  return runDispatcher(opts);
}
