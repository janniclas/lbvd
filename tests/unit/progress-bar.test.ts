import { test } from "node:test";
import assert from "node:assert/strict";
import { countStages, renderProgressLine } from "../../src/progress/bar.js";
import type { TargetStateName } from "../../src/dispatcher/state.js";

const t = (s: TargetStateName): { state: TargetStateName } => ({ state: s });

test("countStages: all queued counts total only", () => {
  const targets = { "a.ts": t("queued"), "b.ts": t("queued") };
  const c = countStages(targets);
  assert.equal(c.total, 2);
  assert.equal(c.scanning, 0);
  assert.equal(c.exploiting, 0);
  assert.equal(c.reporting, 0);
  assert.equal(c.completed, 0);
  assert.equal(c.failed, 0);
});

test("countStages: stage1_running maps to scanning", () => {
  const c = countStages({ "a.ts": t("stage1_running") });
  assert.equal(c.scanning, 1);
  assert.equal(c.total, 1);
});

test("countStages: stage2_running and stage2_done map to exploiting", () => {
  const targets = { "a.ts": t("stage2_running"), "b.ts": t("stage2_done") };
  const c = countStages(targets);
  assert.equal(c.exploiting, 2);
});

test("countStages: all reporting states map to reporting", () => {
  const targets = {
    "a.ts": t("reporting_branch"),
    "b.ts": t("reporting_issue"),
    "c.ts": t("reporting_infra"),
    "d.ts": t("reporting_tracking"),
  };
  const c = countStages(targets);
  assert.equal(c.reporting, 4);
});

test("countStages: done/no_finding/skipped_dup map to completed", () => {
  const targets = {
    "a.ts": t("done"),
    "b.ts": t("no_finding"),
    "c.ts": t("skipped_dup"),
  };
  const c = countStages(targets);
  assert.equal(c.completed, 3);
  assert.equal(c.failed, 0);
});

test("countStages: failed maps to failed", () => {
  const c = countStages({ "a.ts": t("failed") });
  assert.equal(c.failed, 1);
  assert.equal(c.completed, 0);
});

test("countStages: mixed states", () => {
  const targets = {
    "a.ts": t("stage1_running"),
    "b.ts": t("stage2_running"),
    "c.ts": t("done"),
    "d.ts": t("no_finding"),
    "e.ts": t("failed"),
    "f.ts": t("reporting_issue"),
    "g.ts": t("queued"),
  };
  const c = countStages(targets);
  assert.equal(c.total, 7);
  assert.equal(c.scanning, 1);
  assert.equal(c.exploiting, 1);
  assert.equal(c.reporting, 1);
  assert.equal(c.completed, 2);
  assert.equal(c.failed, 1);
});

test("renderProgressLine: contains bar and fraction", () => {
  const targets = {
    "a.ts": t("done"),
    "b.ts": t("stage1_running"),
    "c.ts": t("queued"),
    "d.ts": t("failed"),
  };
  const line = renderProgressLine(targets, 200);
  assert.match(line, /\[.*\]/);
  assert.match(line, /2\/4/);
  assert.match(line, /stage1: 1/);
  assert.match(line, /failed: 1/);
});

test("renderProgressLine: omits zero-count active stages", () => {
  const targets = { "a.ts": t("done"), "b.ts": t("queued") };
  const line = renderProgressLine(targets, 200);
  assert.doesNotMatch(line, /stage1/);
  assert.doesNotMatch(line, /stage2/);
  assert.doesNotMatch(line, /reporting/);
  assert.doesNotMatch(line, /failed/);
});

test("renderProgressLine: truncates to cols", () => {
  const targets = { "a.ts": t("stage1_running"), "b.ts": t("stage2_running") };
  const line = renderProgressLine(targets, 10);
  assert.ok(line.length <= 10, `expected length ≤10, got ${line.length}`);
});

test("renderProgressLine: empty targets shows empty bar", () => {
  const line = renderProgressLine({}, 200);
  assert.match(line, /0\/0/);
  assert.match(line, /░{20}/);
});
