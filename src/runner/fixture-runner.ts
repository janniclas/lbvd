import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Clock } from "../clock/clock.js";
import { redactStream as defaultRedactStream, type Redactor } from "../redaction/redact.js";
import type {
  ProbeRunnerInput,
  Runner,
  RunnerExit,
  RunnerInput,
  SpawnedRunner,
} from "./interface.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveTsxLoader(): string {
  const req = createRequire(import.meta.url);
  return pathToFileURL(req.resolve("tsx/esm")).href;
}

interface State {
  pidToChild: Map<number, ChildProcess>;
}

type RedactStreamFn = (input: NodeJS.ReadableStream) => NodeJS.ReadableStream;

export function makeFixtureRunner(deps: { clock: Clock; redactor?: Redactor }): Runner {
  const state: State = { pidToChild: new Map() };
  const redactStream = deps.redactor?.redactStream ?? defaultRedactStream;
  return {
    kind: "fixture",
    async spawn(input: RunnerInput): Promise<SpawnedRunner> {
      return spawnFixture(input, deps.clock, state, redactStream);
    },
    async spawnProbe(input: ProbeRunnerInput): Promise<SpawnedRunner> {
      return spawnFixtureProbe(input, deps.clock, state);
    },
    async abort(pid: number, gracefulMs = 5000): Promise<void> {
      await abortChild(pid, gracefulMs, state);
    },
  };
}

function captureTranscripts(
  child: ChildProcess,
  input: RunnerInput,
  redactStream: RedactStreamFn,
): void {
  fs.mkdirSync(input.targetSubtree, { recursive: true });
  const transcriptPath = path.join(input.targetSubtree, `stage${input.stage}.transcript`);
  const stream = fs.createWriteStream(transcriptPath, { flags: "a" });
  if (child.stdout !== null) redactStream(child.stdout).pipe(stream, { end: false });
  if (child.stderr !== null) redactStream(child.stderr).pipe(stream, { end: false });
  child.on("exit", () => stream.end());
}

function spawnFixture(
  input: RunnerInput,
  clock: Clock,
  state: State,
  redactStream: RedactStreamFn,
): SpawnedRunner {
  const hostPath = path.join(__dirname, "fixture-host.ts");
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
  child.stdin!.write(JSON.stringify(input));
  child.stdin!.end();
  captureTranscripts(child, input, redactStream);
  const start = clock.monotonicMs();
  const done = new Promise<RunnerExit>((resolve) => {
    child.on("exit", (code, signal) => {
      state.pidToChild.delete(pid);
      resolve({
        code: code ?? -1,
        signal,
        wallSeconds: (clock.monotonicMs() - start) / 1000,
      });
    });
  });
  return { pid, done };
}

function spawnFixtureProbe(
  input: ProbeRunnerInput,
  clock: Clock,
  state: State,
): SpawnedRunner {
  // The fixture probe is a short-lived subprocess so the dispatcher's
  // PID-tracking + abort path stays uniform with stage-1/stage-2.
  const hostPath = path.join(__dirname, "fixture-probe-host.ts");
  const tsxLoader = resolveTsxLoader();
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, hostPath],
    {
      stdio: ["pipe", "ignore", "pipe"],
      env: input.redactedEnv,
      cwd: input.probeSubtree,
    },
  );
  const pid = child.pid ?? -1;
  state.pidToChild.set(pid, child);
  child.stdin!.write(JSON.stringify({ probeSubtree: input.probeSubtree }));
  child.stdin!.end();
  const start = clock.monotonicMs();
  const done = new Promise<RunnerExit>((resolve) => {
    child.on("exit", (code, signal) => {
      state.pidToChild.delete(pid);
      resolve({
        code: code ?? -1,
        signal,
        wallSeconds: (clock.monotonicMs() - start) / 1000,
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
