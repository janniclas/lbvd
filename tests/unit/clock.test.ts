import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicClock, systemClock } from "../../src/clock/clock.js";

test("deterministic clock advances", () => {
  const c = deterministicClock(new Date("2026-01-01T00:00:00Z"));
  const t0 = c.now().getTime();
  c.advance(1500);
  assert.equal(c.now().getTime() - t0, 1500);
  assert.equal(c.monotonicMs(), 1500);
});

test("system clock returns recent date", () => {
  const t = systemClock.now().getTime();
  const drift = Math.abs(Date.now() - t);
  assert.ok(drift < 1000, `drift ${drift}ms`);
});
