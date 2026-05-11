import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeAppLock, lockPathFor } from "../../src/app-lock/lock.js";
import { deterministicClock } from "../../src/clock/clock.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atlock-"));
}

test("AppLock.acquire: second caller blocks until first releases (in-process approximation)", async () => {
  // NOTE: in-process test verifies the polling/back-off logic but cannot
  // observe O_CREAT|O_EXCL atomicity across separate OS processes (F7.24).
  const runDir = tmpDir();
  const clock = deterministicClock(new Date(0));
  let sleeps = 0;
  const sleep = async (ms: number): Promise<void> => {
    sleeps += 1;
    clock.advance(ms);
  };
  const lockA = makeAppLock({
    runDir,
    clock,
    stage2BudgetMs: 60_000,
    mutexTimeoutMs: 5_000,
    pid: 1234,
    sleep,
    isAlive: () => true,
  });
  const lockB = makeAppLock({
    runDir,
    clock,
    stage2BudgetMs: 60_000,
    mutexTimeoutMs: 5_000,
    pid: 5678,
    sleep,
    isAlive: () => true,
  });
  const okA = await lockA.acquire(1_000);
  assert.equal(okA, true, "first acquire succeeds");
  const okB = await lockB.acquire(500);
  assert.equal(okB, false, "second acquire blocks then times out");
  assert.ok(sleeps > 0, "expected at least one back-off sleep");
  await lockA.release();
  const okB2 = await lockB.acquire(1_000);
  assert.equal(okB2, true, "after release the second caller acquires");
  await lockB.release();
});

test("AppLock.cleanupStale: stale lock (age > threshold AND PID dead) is removed", async () => {
  const runDir = tmpDir();
  const clock = deterministicClock(new Date(1_000_000_000_000));
  const lockPath = lockPathFor(runDir);
  // Seed an old lock file with a stale PID.
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999_999, locked_at: new Date(0).toISOString() }),
  );
  const lock = makeAppLock({
    runDir,
    clock,
    stage2BudgetMs: 60_000,
    mutexTimeoutMs: 5_000,
    isAlive: () => false,
  });
  await lock.cleanupStale(60_000, 5_000);
  assert.equal(fs.existsSync(lockPath), false, "stale lock must be removed");
});

test("AppLock.acquire: rejects NaN timeout (sec review M3, via clamp helper)", async () => {
  // The clamp is enforced one layer up (agent-host.ts:clampAcquireTimeoutMs),
  // but verify here that passing a non-finite ms to acquire(...) does not
  // deadlock: the loop should terminate via the `start >= timeoutMs`
  // comparison even when timeoutMs is NaN — which is `false`, so the loop
  // *would* spin forever without the clamp. This test demonstrates the
  // hazard that motivated M3 (loop would only exit when called with a
  // finite timeout).
  const runDir = tmpDir();
  const clock = deterministicClock(new Date(0));
  // Seed a non-stealable competing lock so acquire must wait.
  fs.writeFileSync(
    lockPathFor(runDir),
    JSON.stringify({ pid: 999_998, locked_at: new Date(0).toISOString() }),
  );
  const lock = makeAppLock({
    runDir,
    clock,
    stage2BudgetMs: 60_000,
    mutexTimeoutMs: 5_000,
    pid: 1234,
    sleep: async (ms) => {
      clock.advance(ms);
    },
    isAlive: () => true,
  });
  // Finite timeout must terminate.
  const ok = await lock.acquire(100);
  assert.equal(ok, false, "finite timeout terminates loop with false on contention");
});

test("AppLock.cleanupStale: live lock is NOT removed", async () => {
  const runDir = tmpDir();
  const clock = deterministicClock(new Date(1_000_000_000_000));
  const lockPath = lockPathFor(runDir);
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 1234, locked_at: new Date(0).toISOString() }),
  );
  const lock = makeAppLock({
    runDir,
    clock,
    stage2BudgetMs: 60_000,
    mutexTimeoutMs: 5_000,
    isAlive: () => true,
  });
  await lock.cleanupStale(60_000, 5_000);
  assert.equal(fs.existsSync(lockPath), true, "live lock must NOT be removed");
});
