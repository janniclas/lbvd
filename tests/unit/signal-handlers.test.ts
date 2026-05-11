import { test } from "node:test";
import assert from "node:assert/strict";
import { setupSignalHandlers } from "../../src/dispatcher/loop.js";
import { nullLogger } from "../../src/log/log.js";
import type { Runner, RunnerInput, SpawnedRunner } from "../../src/runner/interface.js";

function makeNoopRunner(): Runner {
  return {
    kind: "fixture",
    async spawn(_input: RunnerInput): Promise<SpawnedRunner> {
      return { pid: 0, done: Promise.resolve({ code: 0, signal: null, wallSeconds: 0 }) };
    },
    async spawnProbe(): Promise<SpawnedRunner> {
      return { pid: 0, done: Promise.resolve({ code: 0, signal: null, wallSeconds: 0 }) };
    },
    async abort(): Promise<void> {},
  };
}

test("setupSignalHandlers: second SIGINT does not re-enter shutdown", () => {
  const inflightSpawns = new Set<{ pid: number }>();
  const runner = makeNoopRunner();
  let abortCalls = 0;
  const wrappedRunner: Runner = {
    ...runner,
    async abort(): Promise<void> {
      abortCalls++;
    },
  };

  const s = setupSignalHandlers({ inflightSpawns, runner: wrappedRunner, logger: nullLogger });

  try {
    assert.equal(s.killed(), false, "initially not killed");
    assert.equal(s.signal(), null, "initially no signal");

    // First delivery: handler fires, sets killed=true (listener stays registered).
    process.emit("SIGINT");
    assert.equal(s.killed(), true, "killed after first SIGINT");
    assert.equal(s.signal(), "SIGINT", "signal recorded");

    // Second delivery: `if (killed) return` guard fires immediately — no re-entry.
    process.emit("SIGINT");
    assert.equal(s.killed(), true, "still killed after second SIGINT");
    assert.equal(abortCalls, 0, "abort not called (no inflight spawns)");
  } finally {
    s.cleanup();
  }
});

test("setupSignalHandlers: cleanup removes listeners before any signal fires", () => {
  const inflightSpawns = new Set<{ pid: number }>();
  const s = setupSignalHandlers({
    inflightSpawns,
    runner: makeNoopRunner(),
    logger: nullLogger,
  });

  s.cleanup();

  assert.equal(s.killed(), false, "not killed after cleanup-only");
  assert.equal(s.signal(), null, "no signal after cleanup-only");
});

test("setupSignalHandlers: SIGTERM is captured and recorded", () => {
  const inflightSpawns = new Set<{ pid: number }>();
  const s = setupSignalHandlers({
    inflightSpawns,
    runner: makeNoopRunner(),
    logger: nullLogger,
  });

  try {
    process.emit("SIGTERM");
    assert.equal(s.killed(), true);
    assert.equal(s.signal(), "SIGTERM");
  } finally {
    s.cleanup();
  }
});
