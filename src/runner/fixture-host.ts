import * as fs from "node:fs";
import * as path from "node:path";
import type { RunnerInput } from "./interface.js";
import { confineToParent } from "../util/safe-path.js";

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  return data;
}

interface FixtureScenarioFile {
  finding?: unknown;
  outcome?: unknown;
  artifacts?: { path: string; content: string }[];
  exit_code?: number;
  exit_after_ms?: number;
}

function fixtureRoot(): string {
  const env = process.env["LBVD_FIXTURE_ROOT"];
  if (env !== undefined) return env;
  return path.resolve("tests/fixtures/canned-agents");
}

function scenarioName(): string {
  return process.env["LBVD_FIXTURE_SCENARIO"] ?? "default";
}

function loadScenarioFile(scenario: string, target: string, stage: 1 | 2): FixtureScenarioFile {
  const root = fixtureRoot();
  const candidates = [
    path.join(root, scenario, target, `stage${stage}.json`),
    path.join(root, scenario, `stage${stage}.json`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return JSON.parse(fs.readFileSync(c, "utf8")) as FixtureScenarioFile;
    }
  }
  throw new Error(
    `fixture-host: no scenario file for ${scenario}/${target} stage ${stage} (looked in ${candidates.join(", ")})`,
  );
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function writeConfined(targetSubtree: string, relPath: string, content: string): void {
  fs.mkdirSync(targetSubtree, { recursive: true });
  // Pre-create the file so realpath can resolve it inside the subtree.
  const target = path.resolve(targetSubtree, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  // Now confine to validate it didn't escape.
  confineToParent({ parent: targetSubtree, candidate: relPath, mustExist: true });
}

async function runStage1(input: RunnerInput, scenario: FixtureScenarioFile): Promise<number> {
  if (scenario.finding !== undefined) {
    writeFile(path.join(input.targetSubtree, "finding.json"), JSON.stringify(scenario.finding, null, 2));
  }
  for (const a of scenario.artifacts ?? []) {
    writeConfined(input.targetSubtree, a.path, a.content);
  }
  if (scenario.exit_after_ms && scenario.exit_after_ms > 0) {
    await new Promise((r) => setTimeout(r, scenario.exit_after_ms));
  }
  return scenario.exit_code ?? 0;
}

async function runStage2(input: RunnerInput, scenario: FixtureScenarioFile): Promise<number> {
  if (scenario.outcome !== undefined) {
    writeFile(path.join(input.targetSubtree, "outcome.json"), JSON.stringify(scenario.outcome, null, 2));
  }
  for (const a of scenario.artifacts ?? []) {
    writeConfined(input.targetSubtree, a.path, a.content);
  }
  if (scenario.exit_after_ms && scenario.exit_after_ms > 0) {
    await new Promise((r) => setTimeout(r, scenario.exit_after_ms));
  }
  return scenario.exit_code ?? 0;
}

async function main(): Promise<number> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as RunnerInput;
  const scenario = loadScenarioFile(scenarioName(), input.targetFile, input.stage);
  if (input.stage === 1) return runStage1(input, scenario);
  return runStage2(input, scenario);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`fixture-host: ${msg}\n`);
    process.exit(1);
  },
);
