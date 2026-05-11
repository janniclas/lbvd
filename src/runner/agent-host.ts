/**
 * SDK runner host process. Reads RunnerInput as JSON on stdin, drives the
 * Claude Agent SDK with the capability set encoded in `RunnerInput.capabilities`,
 * and writes finding.json or outcome.json into the per-target subtree.
 *
 * For `stage === "probe"` (FR-17), the host writes the probe agent's
 * `app-probe.json` into its probe subtree; the dispatcher promotes that
 * intermediate artefact to the canonical dispatcher-zone copy.
 *
 * Capability boundary enforcement is the load-bearing job of this file
 * (architecture §1.3.1, §7.3 / implementation §5.7). The truth is the
 * `decideToolUse` shim in `sdk-tool-shim.ts`; this file only wires it
 * up via the SDK's `canUseTool` permission handler.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AppLockHandle, AppProbeContext, RunnerInput } from "./interface.js";
import { decideToolUse, type ShimGate } from "./sdk-tool-shim.js";
import { stage1SystemPrompt } from "../stage1/prompt.js";
import { stage2SystemPrompt } from "../stage2/prompt.js";
import { probeSystemPrompt } from "../probe/prompt.js";
import type { Finding } from "../stage1/schema.js";
import { systemClock } from "../clock/clock.js";
import { makeAppLock, type AppLock } from "../app-lock/lock.js";

interface HostInput extends Omit<RunnerInput, "stage"> {
  stage: 1 | 2 | "probe";
  sdkModel?: string;
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  return data;
}

interface SdkModule {
  query: (params: {
    prompt: string | AsyncIterable<unknown>;
    options?: Record<string, unknown>;
  }) => AsyncIterable<unknown> & {
    interrupt: () => Promise<void>;
  };
  createSdkMcpServer?: (opts: {
    name: string;
    version?: string;
    tools: unknown[];
  }) => unknown;
  tool?: (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ) => unknown;
}

async function loadSdk(): Promise<SdkModule | null> {
  try {
    return (await import("@anthropic-ai/claude-agent-sdk")) as unknown as SdkModule;
  } catch {
    return null;
  }
}

interface UsageTotals {
  input: number;
  output: number;
}

interface SdkUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface SdkResultMessage {
  type: "result";
  subtype: string;
  is_error?: boolean;
  usage?: SdkUsage;
}

function isResultMessage(m: unknown): m is SdkResultMessage {
  return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "result";
}

const TOOLS_STAGE_1: readonly string[] = ["Read", "Glob", "Grep", "Write"];
const TOOLS_STAGE_2: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Bash",
  "WebFetch",
  "WebSearch",
];
const TOOLS_STAGE_2_WITH_APPLOCK: readonly string[] = [
  ...TOOLS_STAGE_2,
  "mcp__lbvd__AcquireAppLock",
  "mcp__lbvd__ReleaseAppLock",
];

function toolsForStage(stage: 1 | 2 | "probe", canUseAppLock: boolean): readonly string[] {
  if (stage === 1) return TOOLS_STAGE_1;
  if (stage === "probe") return TOOLS_STAGE_2;
  return canUseAppLock ? TOOLS_STAGE_2_WITH_APPLOCK : TOOLS_STAGE_2;
}

// targetFile and targetFilePath must both come from shimGate so the prompt
// and capability gate share the same source of truth.
function buildPrompt(input: HostInput, targetFile: string, targetFilePath: string): string {
  if (input.stage === 1) {
    return stage1SystemPrompt({
      targetFile,
      targetFilePath,
      scanScope: input.scanScope ?? "hint+verify",
    });
  }
  if (input.stage === "probe") {
    return probeSystemPrompt({ repoRoot: input.repoRoot });
  }
  return stage2SystemPrompt(input.finding as Finding, input.appProbe ?? null);
}

function resolveModel(input: HostInput): string {
  if (typeof input.sdkModel !== "string" || input.sdkModel.length === 0) {
    throw new Error("agent-host: missing sdkModel from dispatcher");
  }
  return input.sdkModel;
}

interface AppLockGate {
  appLock: AppLock | null;
  expose: boolean;
  /** Operator-configured upper bound (ms) for AcquireAppLock timeout. */
  mutexTimeoutMs: number;
}

function buildAppLockGate(input: HostInput): AppLockGate {
  if (input.stage !== 2) return { appLock: null, expose: false, mutexTimeoutMs: 0 };
  const ctx = input.appProbe ?? null;
  const handle = input.appLock ?? null;
  if (ctx === null || handle === null || !ctx.startable) {
    return { appLock: null, expose: false, mutexTimeoutMs: 0 };
  }
  const lock = makeAppLock({
    runDir: input.runDir,
    clock: systemClock,
    stage2BudgetMs: handle.stage2BudgetMs,
    mutexTimeoutMs: handle.mutexTimeoutMs,
  });
  return { appLock: lock, expose: true, mutexTimeoutMs: handle.mutexTimeoutMs };
}

/**
 * Clamp agent-supplied `timeout_seconds` to the operator-configured
 * `mutexTimeoutMs` cap. Rejects NaN/Infinity (they pass `typeof === "number"`)
 * and negative values; falls back to the cap on invalid inputs. Sec
 * review M3.
 */
function clampAcquireTimeoutMs(args: Record<string, unknown>, capMs: number): number {
  const raw = args["timeout_seconds"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return capMs;
  const ms = raw * 1000;
  return Math.min(ms, capMs);
}

interface McpServerSpec {
  servers: Record<string, unknown>;
}

async function loadZod(): Promise<{ z: { number: () => unknown; object: (s: Record<string, unknown>) => unknown } } | null> {
  try {
    const mod = (await import("zod")) as unknown as { z: { number: () => unknown; object: (s: Record<string, unknown>) => unknown } };
    return mod;
  } catch {
    return null;
  }
}

async function buildMcpServers(sdk: SdkModule, gate: AppLockGate): Promise<McpServerSpec> {
  if (!gate.expose || gate.appLock === null) return { servers: {} };
  if (typeof sdk.createSdkMcpServer !== "function" || typeof sdk.tool !== "function") {
    // SDK build does not expose the in-process MCP helpers; skip rather
    // than crash. The agent runs without the lock tools; the prompt's
    // fallback instructions ("downgrade to Tier 2 if mutex unavailable")
    // cover this case.
    return { servers: {} };
  }
  const zMod = await loadZod();
  if (zMod === null) return { servers: {} };
  const lock = gate.appLock;
  const acquireSchema = { timeout_seconds: zMod.z.number() } as Record<string, unknown>;
  const releaseSchema = {} as Record<string, unknown>;
  const capMs = gate.mutexTimeoutMs;
  const acquire = sdk.tool(
    "AcquireAppLock",
    "Acquire exclusive access to the running application before starting it. Returns { acquired: true } on success or { acquired: false, reason } on timeout.",
    acquireSchema,
    async (args: Record<string, unknown>) => {
      const ms = clampAcquireTimeoutMs(args, capMs);
      const ok = await lock.acquire(ms);
      const payload = ok ? { acquired: true } : { acquired: false, reason: "timeout" };
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  );
  const release = sdk.tool(
    "ReleaseAppLock",
    "Release exclusive access to the running application. Always call after stopping the app.",
    releaseSchema,
    async () => {
      await lock.release();
      return { content: [{ type: "text", text: JSON.stringify({ released: true }) }] };
    },
  );
  const server = sdk.createSdkMcpServer({
    name: "lbvd",
    version: "1.0.0",
    tools: [acquire, release],
  });
  return { servers: { lbvd: server } };
}

interface QueryOpts {
  sdk: SdkModule;
  input: HostInput;
  shimGate: ShimGate;
  appLockGate: AppLockGate;
  controller: AbortController;
}

function userMessage(input: HostInput, targetFilePath: string): string {
  if (input.stage === 1) {
    return `Scan ${targetFilePath} and write ./finding.json per the system prompt, then exit.`;
  }
  if (input.stage === "probe") {
    return `Detect how to start the application in ${input.repoRoot}, prove it by starting and stopping it, then write ./app-probe.json and exit.`;
  }
  return `Implement the highest tier you can substantiate for the finding above and write ./outcome.json, then exit.`;
}

async function runQuery(opts: QueryOpts): Promise<UsageTotals> {
  const { sdk, input, shimGate, appLockGate, controller } = opts;
  const totals: UsageTotals = { input: 0, output: 0 };
  const targetFilePath = path.resolve(shimGate.repoRoot, shimGate.targetFile).replace(/[\r\n\0]/g, "");
  const mcp = await buildMcpServers(sdk, appLockGate);
  const queryGen = sdk.query({
    prompt: userMessage(input, targetFilePath),
    options: {
      cwd: shimGate.targetSubtree,
      additionalDirectories: [shimGate.repoRoot],
      model: resolveModel(input),
      tools: [...toolsForStage(input.stage, appLockGate.expose)],
      mcpServers: mcp.servers,
      systemPrompt: buildPrompt(input, shimGate.targetFile, targetFilePath),
      canUseTool: async (toolName: string, toolInput: Record<string, unknown>) => {
        // MCP-provided tools route through canUseTool too. Allow them
        // through; their internal logic enforces the contract.
        if (toolName.startsWith("mcp__lbvd__")) return { behavior: "allow" };
        const decision = decideToolUse(toolName, toolInput, shimGate);
        if (decision.behavior === "allow") return { behavior: "allow" };
        return { behavior: "deny", message: decision.message };
      },
      abortController: controller,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });
  for await (const message of queryGen) {
    if (isResultMessage(message)) {
      totals.input += message.usage?.input_tokens ?? 0;
      totals.output += message.usage?.output_tokens ?? 0;
    }
  }
  return totals;
}

function patchTokenUsage(filePath: string, key: string, totals: UsageTotals): void {
  if (!fs.existsSync(filePath)) return;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    data[key] = { input: totals.input, output: totals.output };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch {
    // If the agent produced invalid JSON, the dispatcher's validator will
    // surface the failure. Don't mask it here.
  }
}

function realpathOrThrow(p: string, label: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`agent-host: cannot canonicalize ${label} '${p}': ${msg}`);
  }
}

function persistTokenUsage(input: HostInput, totals: UsageTotals): void {
  if (input.stage === 1) {
    patchTokenUsage(path.join(input.targetSubtree, "finding.json"), "stage1_token_usage", totals);
    return;
  }
  if (input.stage === "probe") {
    patchTokenUsage(path.join(input.targetSubtree, "app-probe.json"), "probe_token_usage", totals);
    return;
  }
  patchTokenUsage(path.join(input.targetSubtree, "outcome.json"), "stage2_token_usage", totals);
}

async function runStage(input: HostInput): Promise<number> {
  fs.mkdirSync(input.targetSubtree, { recursive: true });
  // Canonicalize the parents BEFORE constructing the shim gate. For the
  // probe stage, the write zone is the probe subtree which the dispatcher
  // passes as `targetSubtree` (see sdk-runner's `spawnProbeHost`).
  const repoRoot = realpathOrThrow(input.repoRoot, "repoRoot");
  const targetSubtree = realpathOrThrow(input.targetSubtree, "targetSubtree");
  const shimGate: ShimGate = {
    caps: input.capabilities,
    repoRoot,
    targetSubtree,
    targetFile: input.targetFile,
    scanScope: input.scanScope ?? "hint+verify",
  };
  const appLockGate = buildAppLockGate(input);
  const sdk = await loadSdk();
  if (sdk === null) {
    process.stderr.write("agent-host: @anthropic-ai/claude-agent-sdk not installed\n");
    return 1;
  }
  const controller = new AbortController();
  let totals: UsageTotals;
  try {
    totals = await runQuery({ sdk, input, shimGate, appLockGate, controller });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`agent-host: SDK query failed: ${msg}\n`);
    return 1;
  }
  persistTokenUsage(input, totals);
  return 0;
}

async function main(): Promise<number> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as HostInput;
  return runStage(input);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`agent-host: ${msg}\n`);
    process.exit(1);
  },
);
