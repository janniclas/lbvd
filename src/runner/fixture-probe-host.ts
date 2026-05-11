/**
 * Fixture-runner counterpart for the probe phase. Reads the scenario's
 * `probe/app-probe.json` from the fixture corpus and writes it to the
 * probe subtree. Mirrors the existing `fixture-host.ts` pattern.
 */
import * as fs from "node:fs";
import * as path from "node:path";

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  return data;
}

function fixtureRoot(): string {
  const env = process.env["LBVD_FIXTURE_ROOT"];
  if (env !== undefined) return env;
  return path.resolve("tests/fixtures/canned-agents");
}

function scenarioName(): string {
  return process.env["LBVD_FIXTURE_SCENARIO"] ?? "default";
}

interface ProbeScenarioFile {
  probe?: unknown;
  hang_ms?: number;
}

function loadScenarioProbe(): ProbeScenarioFile {
  const candidate = path.join(fixtureRoot(), scenarioName(), "probe", "app-probe.json");
  if (!fs.existsSync(candidate)) return {};
  const raw = JSON.parse(fs.readFileSync(candidate, "utf8")) as Record<string, unknown>;
  // If the file is wrapped in `{ probe: ..., hang_ms: N }`, honour the
  // wrapper. Otherwise treat the entire file as the probe payload (the
  // common case).
  if ("probe" in raw || "hang_ms" in raw) {
    return raw as ProbeScenarioFile;
  }
  return { probe: raw };
}

function synthesizedUnstartable(): unknown {
  return {
    schema_version: 1,
    startable: false,
    start_commands: [],
    stop_commands: [],
    port: null,
    health_check_url: null,
    startup_timeout_seconds: 0,
    pre_conditions: [],
    probe_narrative: "fixture probe: no scenario probe file",
    tried: false,
    successfully_started: false,
    failure_reason: "no startup artefacts found",
    probe_token_usage: { input: 0, output: 0 },
    probe_wall_seconds: 0,
  };
}

interface ProbeStdin {
  probeSubtree: string;
}

async function main(): Promise<number> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as ProbeStdin;
  fs.mkdirSync(input.probeSubtree, { recursive: true });
  const scenario = loadScenarioProbe();
  // Optional pre-write delay so workflow tests can exercise the
  // probe-wall-clock-cap path. SIGTERM from the dispatcher (FR-17 / F7.21)
  // lands during the sleep and kills the host before any file is written.
  if (typeof scenario.hang_ms === "number" && scenario.hang_ms > 0) {
    await new Promise((r) => setTimeout(r, scenario.hang_ms));
  }
  const out = scenario.probe ?? synthesizedUnstartable();
  const dest = path.join(input.probeSubtree, "app-probe.json");
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`fixture-probe-host: ${msg}\n`);
    process.exit(1);
  },
);
