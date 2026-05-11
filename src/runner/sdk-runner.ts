import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../log/log.js";
import type { ResolvedConfig } from "../config/defaults.js";
import type {
  ProbeRunnerInput,
  Runner,
  RunnerExit,
  RunnerInput,
  SpawnedRunner,
} from "./interface.js";
import { redactStream as defaultRedactStream, type Redactor } from "../redaction/redact.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface State {
  pidToChild: Map<number, ChildProcess>;
}

interface Deps {
  config: ResolvedConfig;
  clock: Clock;
  logger: Logger;
  redactor?: Redactor;
}

export function makeSdkRunner(deps: Deps): Runner {
  const state: State = { pidToChild: new Map() };
  const redactStream = deps.redactor?.redactStream ?? defaultRedactStream;
  return {
    kind: "sdk",
    async spawn(input: RunnerInput): Promise<SpawnedRunner> {
      return spawnAgentHost(input, deps, state, redactStream);
    },
    async spawnProbe(input: ProbeRunnerInput): Promise<SpawnedRunner> {
      return spawnProbeHost(input, deps, state, redactStream);
    },
    async abort(pid: number, gracefulMs = 5000): Promise<void> {
      await abortChild(pid, gracefulMs, state);
    },
  };
}

function resolveTsxLoader(): string {
  const req = createRequire(import.meta.url);
  return pathToFileURL(req.resolve("tsx/esm")).href;
}

type RedactStreamFn = (input: NodeJS.ReadableStream) => NodeJS.ReadableStream;

function spawnAgentHost(
  input: RunnerInput,
  deps: Deps,
  state: State,
  redactStream: RedactStreamFn,
): SpawnedRunner {
  const hostPath = path.join(__dirname, "agent-host.ts");
  const tsxLoader = resolveTsxLoader();
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, hostPath],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: input.redactedEnv,
      cwd: input.targetSubtree,
    },
  );
  const pid = child.pid ?? -1;
  state.pidToChild.set(pid, child);
  child.stdin!.write(JSON.stringify({ ...input, sdkModel: deps.config.runner.sdk.model }));
  child.stdin!.end();
  captureTranscripts(child, input, redactStream);
  const start = deps.clock.monotonicMs();
  const done = new Promise<RunnerExit>((resolve) => {
    child.on("exit", (code, signal) => {
      state.pidToChild.delete(pid);
      resolve({
        code: code ?? -1,
        signal,
        wallSeconds: (deps.clock.monotonicMs() - start) / 1000,
      });
    });
  });
  return { pid, done };
}

function captureTranscripts(
  child: ChildProcess,
  input: RunnerInput,
  redactStream: RedactStreamFn,
): void {
  const stage = input.stage;
  const transcriptPath = path.join(input.targetSubtree, `stage${stage}.transcript`);
  fs.mkdirSync(input.targetSubtree, { recursive: true });
  const stream = fs.createWriteStream(transcriptPath, { flags: "a" });
  if (child.stdout !== null) redactStream(child.stdout).pipe(stream, { end: false });
  if (child.stderr !== null) redactStream(child.stderr).pipe(stream, { end: false });
  child.on("exit", () => stream.end());
}

function captureProbeTranscripts(
  child: ChildProcess,
  input: ProbeRunnerInput,
  redactStream: RedactStreamFn,
): void {
  const transcriptPath = path.join(input.probeSubtree, "probe.transcript");
  fs.mkdirSync(input.probeSubtree, { recursive: true });
  const stream = fs.createWriteStream(transcriptPath, { flags: "a" });
  if (child.stdout !== null) redactStream(child.stdout).pipe(stream, { end: false });
  if (child.stderr !== null) redactStream(child.stderr).pipe(stream, { end: false });
  child.on("exit", () => stream.end());
}

function spawnProbeHost(
  input: ProbeRunnerInput,
  deps: Deps,
  state: State,
  redactStream: RedactStreamFn,
): SpawnedRunner {
  // The probe is invoked via the same agent-host but with `stage: "probe"`.
  // The host reads the discriminant and exposes the probe-specific prompt
  // + write-zone (probeSubtree).
  const hostPath = path.join(__dirname, "agent-host.ts");
  const tsxLoader = resolveTsxLoader();
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, hostPath],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: input.redactedEnv,
      cwd: input.probeSubtree,
    },
  );
  const pid = child.pid ?? -1;
  state.pidToChild.set(pid, child);
  // Reuse the existing RunnerInput JSON shape but mark stage="probe" so the
  // host's shim treats probeSubtree as the write zone. `targetSubtree` and
  // `targetFile` are filled with probe-appropriate placeholders that the
  // probe-specific code path in `agent-host.ts` reroutes through
  // `probeSubtree`.
  const hostInput = {
    runDir: input.runDir,
    // probeSubtree IS the write zone for the probe agent; the agent-host
    // shim enforces confinement on `targetSubtree`.
    targetSubtree: input.probeSubtree,
    targetFile: "",
    repoRoot: input.repoRoot,
    stage: "probe" as const,
    capabilities: input.capabilities,
    budgetSeconds: input.budgetSeconds,
    redactedEnv: input.redactedEnv,
    sdkModel: deps.config.runner.sdk.model,
  };
  child.stdin!.write(JSON.stringify(hostInput));
  child.stdin!.end();
  captureProbeTranscripts(child, input, redactStream);
  const start = deps.clock.monotonicMs();
  const done = new Promise<RunnerExit>((resolve) => {
    child.on("exit", (code, signal) => {
      state.pidToChild.delete(pid);
      resolve({
        code: code ?? -1,
        signal,
        wallSeconds: (deps.clock.monotonicMs() - start) / 1000,
      });
    });
  });
  return { pid, done };
}

async function abortChild(pid: number, gracefulMs: number, state: State): Promise<void> {
  const child = state.pidToChild.get(pid);
  if (child === undefined) return;
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve();
    }, gracefulMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
