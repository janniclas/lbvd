import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../../src/routing/route.js";

test("tier 1 always high, no branch decision change by severity", () => {
  for (const sev of ["low", "medium", "high"] as const) {
    const r = route(1, sev);
    assert.equal(r.priority, "high");
    assert.equal(r.basePriority, "high");
    assert.equal(r.branch, true);
    assert.equal(r.bumpReason, "none");
  }
});

test("tier 2 low/medium → medium, tier 2 high bumps to high", () => {
  assert.equal(route(2, "low").priority, "medium");
  assert.equal(route(2, "medium").priority, "medium");
  const high = route(2, "high");
  assert.equal(high.priority, "high");
  assert.equal(high.basePriority, "medium");
  assert.match(high.bumpReason, /base medium/);
  assert.equal(high.branch, true);
});

test("tier 3 never branches; severity bumps priority but not branch", () => {
  const low = route(3, "low");
  assert.equal(low.branch, false);
  assert.equal(low.priority, "low");
  const med = route(3, "medium");
  assert.equal(med.branch, false);
  assert.equal(med.priority, "medium");
  assert.match(med.bumpReason, /base low/);
  const high = route(3, "high");
  assert.equal(high.branch, false);
  assert.equal(high.priority, "medium");
});
