import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildManifest } from "../../src/manifest/build.js";
import { systemClock } from "../../src/clock/clock.js";
import { initState } from "../../src/dispatcher/state.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atmp-"));
}

test("manifest: app_probe is null when no app-probe.json present", () => {
  const runDir = tmpDir();
  const state = initState({
    runId: "20260511T120000Z-deadbeef",
    config: DEFAULT_CONFIG,
    startedAt: "2026-05-11T12:00:00Z",
    targets: {},
  });
  const m = buildManifest({ runDir, state, clock: systemClock });
  assert.equal(m.app_probe, null);
});

test("manifest: app_probe carries startable/narrative/wall when file present", () => {
  const runDir = tmpDir();
  const probe = {
    schema_version: 1,
    startable: true,
    start_commands: ["node x"],
    stop_commands: ["pkill x"],
    port: 8080,
    health_check_url: null,
    startup_timeout_seconds: 5,
    pre_conditions: [],
    probe_narrative: "fixture narrative",
    tried: true,
    successfully_started: true,
    failure_reason: null,
    probe_token_usage: { input: 1, output: 2 },
    probe_wall_seconds: 3.14,
  };
  fs.writeFileSync(path.join(runDir, "app-probe.json"), JSON.stringify(probe, null, 2));
  const state = initState({
    runId: "20260511T120000Z-deadbeef",
    config: DEFAULT_CONFIG,
    startedAt: "2026-05-11T12:00:00Z",
    targets: {},
  });
  const m = buildManifest({ runDir, state, clock: systemClock });
  assert.deepEqual(m.app_probe, {
    startable: true,
    probe_narrative: "fixture narrative",
    probe_wall_seconds: 3.14,
  });
});

test("manifest: probe_narrative is redacted and newline-stripped", () => {
  const runDir = tmpDir();
  // Embed a known secret-shaped literal that the default redactor masks
  // (GitHub token); ANSI escape and newline are sanitised.
  const narrative = "saw [31mhttps://example.com[0m and ghp_abcdef0123456789abcdef0123456789abcdef\nplus a second line";
  const probe = {
    schema_version: 1,
    startable: true,
    start_commands: ["node x"],
    stop_commands: ["pkill x"],
    port: 8080,
    health_check_url: null,
    startup_timeout_seconds: 5,
    pre_conditions: [],
    probe_narrative: narrative,
    tried: true,
    successfully_started: true,
    failure_reason: null,
    probe_token_usage: { input: 1, output: 2 },
    probe_wall_seconds: 1.0,
  };
  fs.writeFileSync(path.join(runDir, "app-probe.json"), JSON.stringify(probe, null, 2));
  const state = initState({
    runId: "20260511T120000Z-deadbeef",
    config: DEFAULT_CONFIG,
    startedAt: "2026-05-11T12:00:00Z",
    targets: {},
  });
  const m = buildManifest({ runDir, state, clock: systemClock });
  const rendered = m.app_probe?.probe_narrative ?? "";
  // Newlines were collapsed and ANSI was stripped.
  assert.ok(!rendered.includes("\n"), `newlines must be stripped, got: ${JSON.stringify(rendered)}`);
  assert.ok(!rendered.includes("["), "ANSI must be stripped");
  // The npm-token literal must NOT appear in the redacted output.
  assert.ok(!rendered.includes("ghp_abcdef0123456789abcdef0123456789abcdef"), "secret-shaped literal must be redacted");
});

test("manifest: app_probe is null for malformed app-probe.json", () => {
  const runDir = tmpDir();
  fs.writeFileSync(path.join(runDir, "app-probe.json"), "not json");
  const state = initState({
    runId: "20260511T120000Z-deadbeef",
    config: DEFAULT_CONFIG,
    startedAt: "2026-05-11T12:00:00Z",
    targets: {},
  });
  const m = buildManifest({ runDir, state, clock: systemClock });
  assert.equal(m.app_probe, null);
});
