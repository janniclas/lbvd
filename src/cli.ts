#!/usr/bin/env node
import { Command } from "commander";
import { runScan } from "./dispatcher/index.js";
import { runReport } from "./manifest/report.js";
import { runDryRun } from "./discovery/dry-run.js";
import {
  ConfigError,
  loadConfig,
  resolveAuthCredential,
  type AuthMode,
  type ResolvedAuthCredential,
  type ResolvedConfig,
} from "./config/load.js";
import { makeRedactor, type Redactor } from "./redaction/redact.js";
import { systemClock, type Clock } from "./clock/clock.js";
import { makeLogger, type Logger } from "./log/log.js";
import { isValidRunId } from "./util/safe-path.js";
import { safeStderr } from "./util/safe-stderr.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PKG_VERSION = (JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  ),
) as { version: string }).version;

function checkRunId(runId: string): boolean {
  if (!isValidRunId(runId)) {
    safeStderr(
      `lbvd: --run-id ${runId} is malformed. Required: YYYYMMDDTHHMMSSZ-<hex>.\n`,
    );
    return false;
  }
  return true;
}

interface CommonFlags {
  config?: string;
  concurrency?: string;
  scope?: "hint_only" | "hint+verify" | "repo_wide";
  dryRun?: boolean;
  runId?: string;
  authMode?: AuthMode;
}

function buildLoadFlags(opts: CommonFlags, configPath: string): {
  configPath: string;
  concurrency?: number;
  scope?: "hint_only" | "hint+verify" | "repo_wide";
  runId?: string;
  dryRun?: boolean;
  authMode?: AuthMode;
} {
  return {
    ...(opts.concurrency !== undefined && { concurrency: Number(opts.concurrency) }),
    ...(opts.scope !== undefined && { scope: opts.scope }),
    configPath,
    ...(opts.runId !== undefined && { runId: opts.runId }),
    ...(opts.dryRun !== undefined && { dryRun: opts.dryRun }),
    ...(opts.authMode !== undefined && { authMode: opts.authMode }),
  };
}

interface StartupArtifacts {
  config: ResolvedConfig;
  credential: ResolvedAuthCredential | null;
  redactor: Redactor;
  logger: Logger;
}

function isFixtureRunner(config: ResolvedConfig, env: NodeJS.ProcessEnv): boolean {
  // FR-15 fixture carve-out (architecture §20.3): the fixture runner never
  // spawns the SDK, so no Anthropic credential is required and there is no
  // token literal to mask. Env override is checked first to match
  // selectRunner's precedence — operators with `LBVD_RUNNER=sdk`
  // lingering in their environment still get the credential check.
  return env["LBVD_RUNNER"] === "fixture" || config.runner.kind === "fixture";
}

function buildStartup(opts: {
  configPath: string;
  loadFlags: ReturnType<typeof buildLoadFlags>;
  runId: string;
  runDir: string;
  clock: Clock;
  dryRun: false;
}): StartupArtifacts {
  const config = loadConfig({ configPath: opts.configPath, flags: opts.loadFlags, env: process.env });
  const credential = isFixtureRunner(config, process.env)
    ? null
    : resolveAuthCredential(config, process.env);
  const extraLiterals = credential !== null ? [credential.tokenValue] : [];
  const redactor = makeRedactor({ extraLiterals });
  fs.mkdirSync(opts.runDir, { recursive: true });
  const logger = makeLogger({
    runId: opts.runId,
    debugFilePath: path.join(opts.runDir, "debug.log"),
    clock: opts.clock,
    redactor,
  });
  if (redactor.literalsDropped > 0) {
    logger.info("redaction.literal_dropped", { dropped: redactor.literalsDropped });
  }
  return { config, credential, redactor, logger };
}

async function runScanCmd(
  mode: "scan-all" | "scan-changes",
  opts: CommonFlags,
): Promise<number> {
  const cwd = process.cwd();
  const configPath = opts.config ?? path.join(cwd, "lbvd.yaml");
  const loadFlags = buildLoadFlags(opts, configPath);
  const clock = systemClock;
  if (opts.dryRun === true) {
    const dryConfig = catchConfigError(() => loadConfig({ configPath, flags: loadFlags, env: process.env }));
    if (typeof dryConfig === "number") return dryConfig;
    return runDryRun({ mode, cwd, config: dryConfig });
  }
  const runId = opts.runId ?? generateRunId(clock);
  if (!checkRunId(runId)) return 3;
  const runDir = path.join(cwd, ".lbvd", runId);
  const startup = catchConfigError(() =>
    buildStartup({ configPath, loadFlags, runId, runDir, clock, dryRun: false }),
  );
  if (typeof startup === "number") return startup;
  const result = await runScan({
    config: startup.config,
    clock,
    runId,
    mode,
    cwd,
    logger: startup.logger,
    redactor: startup.redactor,
  });
  return result.exitCode;
}

function catchConfigError<T>(fn: () => T): T | number {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ConfigError) {
      safeStderr(`lbvd: ${e.message}\n`);
      return e.exitCode;
    }
    throw e;
  }
}

function generateRunId(clock: { now(): Date }): string {
  const d = clock.now();
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const suffix = crypto.randomBytes(4).toString("hex");
  return `${ts}-${suffix}`;
}

async function runResumeCmd(
  runId: string,
  opts: { config?: string; authMode?: AuthMode },
): Promise<number> {
  if (!checkRunId(runId)) return 3;
  const cwd = process.cwd();
  const configPath = opts.config ?? path.join(cwd, "lbvd.yaml");
  const loadFlags = {
    configPath,
    ...(opts.authMode !== undefined && { authMode: opts.authMode }),
  };
  const clock = systemClock;
  const runDir = path.join(cwd, ".lbvd", runId);
  if (!fs.existsSync(runDir)) {
    safeStderr(`lbvd: run-id ${runId} not found at ${runDir}\n`);
    return 1;
  }
  const startup = catchConfigError(() =>
    buildStartup({ configPath, loadFlags, runId, runDir, clock, dryRun: false }),
  );
  if (typeof startup === "number") return startup;
  const result = await runScan({
    config: startup.config,
    clock,
    runId,
    mode: "resume",
    cwd,
    logger: startup.logger,
    redactor: startup.redactor,
  });
  return result.exitCode;
}

async function runReportCmd(runId: string): Promise<number> {
  if (!checkRunId(runId)) return 3;
  const cwd = process.cwd();
  return runReport({ runId, cwd });
}

function parseAuthModeArg(raw: string): AuthMode {
  if (raw !== "api_key" && raw !== "subscription") {
    throw new Error(`--auth-mode must be 'api_key' or 'subscription' (got '${raw}').`);
  }
  return raw;
}

// Exit codes (architecture §13.2): 0=success, 1=crash, 2=preflight, 3=config,
// 4=run_budget, 5=no_targets, 6=signal_interrupted (FR-16)
async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("lbvd")
    .description(
      "Automated vulnerability scanner. Two-stage agent pipeline (find → exploit/test) over a repo.\n\nRecommended: DIY-cloud above --concurrency 4 or for runs over 2 hours.\n\nWeb-sandbox substrate requires auth.mode=subscription with CLAUDE_CODE_OAUTH_TOKEN (see README).",
    )
    .version(PKG_VERSION);

  for (const mode of ["scan-all", "scan-changes"] as const) {
    program
      .command(mode)
      .description(
        mode === "scan-all"
          ? "Scan every tracked file in the repo (post-blacklist)."
          : "Scan only files staged with `git add`.",
      )
      .option("--config <path>", "config YAML path (default: ./lbvd.yaml)")
      .option("--concurrency <n>", "max concurrent pipelines")
      .option("--scope <scope>", "scan scope: hint_only | hint+verify | repo_wide")
      .option("--dry-run", "resolve targets and exit without invoking agents")
      .option("--run-id <id>", "use the given run id instead of generating one")
      .option("--auth-mode <mode>", "agent auth mode: api_key | subscription", parseAuthModeArg)
      .action(async (opts) => {
        process.exitCode = await runScanCmd(mode, opts);
      });
  }

  program
    .command("resume <run-id>")
    .description("Resume an interrupted run.")
    .option("--config <path>", "config YAML path (default: ./lbvd.yaml)")
    .option("--auth-mode <mode>", "agent auth mode: api_key | subscription", parseAuthModeArg)
    .action(async (runId: string, opts) => {
      process.exitCode = await runResumeCmd(runId, opts);
    });

  program
    .command("report <run-id>")
    .description("Print the manifest of a completed run.")
    .action(async (runId: string) => {
      process.exitCode = await runReportCmd(runId);
    });

  await program.parseAsync(argv);
}

main(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  safeStderr(`lbvd: fatal: ${msg}\n`);
  process.exit(1);
});
