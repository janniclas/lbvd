/**
 * Filesystem mutex for serializing Stage 2 live-application verification
 * (architecture §22.4 / §22.7). At most one Stage 2 agent-host may hold
 * the lock at a time. Atomic creation uses `O_CREAT | O_EXCL`; release
 * is `unlink`. Stale locks are reaped at every dispatcher startup and
 * during acquire-time polling, gated on both PID liveness and lock age.
 *
 * Sole writer/reader of `<runDir>/app-access.lock`. The
 * `AcquireAppLock` / `ReleaseAppLock` tools in `agent-host.ts` route
 * through the `AppLock` interface — see plans/implementation.md §10.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Clock } from "../clock/clock.js";

export interface AppLock {
  /** Returns true if the lock was acquired within `timeoutMs`. */
  acquire(timeoutMs: number): Promise<boolean>;
  /** Best-effort unlink of the lock file. Silent when the lock is unheld. */
  release(): Promise<void>;
  /**
   * Remove the lock file if it is stale (age > stage2 + mutex threshold
   * AND the recorded PID is no longer alive). Architecture §22.7.
   */
  cleanupStale(stage2BudgetMs: number, mutexTimeoutMs: number): Promise<void>;
}

export interface AppLockOpts {
  runDir: string;
  clock: Clock;
  /**
   * Budgets used by the acquire-time staleness check. Per architecture
   * §22.4: a live holder may have waited up to `mutexTimeoutMs` before
   * acquiring, so ages ≤ `stage2BudgetMs + mutexTimeoutMs` cannot be
   * declared stale even if the PID appears dead (PID-reuse window).
   */
  stage2BudgetMs: number;
  mutexTimeoutMs: number;
  pid?: number;
  /** Test seam: deliver predictable back-off in unit tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: stub PID-liveness probe. */
  isAlive?: (pid: number) => boolean;
}

interface LockFile {
  pid: number;
  locked_at: string;
}

const INITIAL_BACKOFF_MS = 20;
const MAX_BACKOFF_MS = 500;

export function lockPathFor(runDir: string): string {
  return path.join(runDir, "app-access.lock");
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we cannot signal it (different uid).
    // Treat that as alive — it is not safe to steal the lock.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readLockFile(p: string): LockFile | null {
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockFile>;
    if (typeof parsed.pid !== "number" || typeof parsed.locked_at !== "string") {
      return null;
    }
    return { pid: parsed.pid, locked_at: parsed.locked_at };
  } catch {
    return null;
  }
}

interface StaleArgs {
  lockPath: string;
  stage2BudgetMs: number;
  mutexTimeoutMs: number;
  clock: Clock;
  isAlive: (pid: number) => boolean;
}

/**
 * Stale = PID dead AND lock age > stage2 + mutex timeout. Both gates
 * required: a live PID never permits a steal; a recent lock never
 * permits a steal (defeats PID reuse). Architecture §22.4.
 */
function isLockStale(opts: StaleArgs): boolean {
  const lf = readLockFile(opts.lockPath);
  if (lf === null) return true;
  if (opts.isAlive(lf.pid)) return false;
  const lockedAtMs = Date.parse(lf.locked_at);
  if (!Number.isFinite(lockedAtMs)) return true;
  const ageMs = opts.clock.now().getTime() - lockedAtMs;
  return ageMs > opts.stage2BudgetMs + opts.mutexTimeoutMs;
}

function tryCreate(lockPath: string, pid: number, lockedAt: string): "created" | "exists" | "error" {
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, JSON.stringify({ pid, locked_at: lockedAt }));
    fs.closeSync(fd);
    return "created";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "error";
  }
}

function removeIfStale(args: StaleArgs): void {
  if (!fs.existsSync(args.lockPath)) return;
  if (!isLockStale(args)) return;
  try {
    fs.rmSync(args.lockPath, { force: true });
  } catch {
    /* ignore */
  }
}

interface AcquireDeps {
  lockPath: string;
  pid: number;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  isAlive: (pid: number) => boolean;
  stage2BudgetMs: number;
  mutexTimeoutMs: number;
}

async function acquireLoop(deps: AcquireDeps, timeoutMs: number): Promise<boolean> {
  const start = deps.clock.now().getTime();
  let backoff = INITIAL_BACKOFF_MS;
  while (true) {
    const lockedAt = deps.clock.now().toISOString();
    const r = tryCreate(deps.lockPath, deps.pid, lockedAt);
    if (r === "created") return true;
    if (r === "exists") {
      // Maybe stale; opportunistic steal then retry. Steal is a no-op
      // when the lock is live, so the next iteration still polls.
      removeIfStale({
        lockPath: deps.lockPath,
        stage2BudgetMs: deps.stage2BudgetMs,
        mutexTimeoutMs: deps.mutexTimeoutMs,
        clock: deps.clock,
        isAlive: deps.isAlive,
      });
    }
    if (deps.clock.now().getTime() - start >= timeoutMs) return false;
    await deps.sleep(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

export function makeAppLock(opts: AppLockOpts): AppLock {
  const lockPath = lockPathFor(opts.runDir);
  const pid = opts.pid ?? process.pid;
  const sleep = opts.sleep ?? defaultSleep;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const clock = opts.clock;
  return {
    async acquire(timeoutMs: number): Promise<boolean> {
      return acquireLoop(
        {
          lockPath,
          pid,
          clock,
          sleep,
          isAlive,
          stage2BudgetMs: opts.stage2BudgetMs,
          mutexTimeoutMs: opts.mutexTimeoutMs,
        },
        timeoutMs,
      );
    },
    async release(): Promise<void> {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        /* ignore */
      }
    },
    async cleanupStale(stage2BudgetMs: number, mutexTimeoutMs: number): Promise<void> {
      removeIfStale({
        lockPath,
        stage2BudgetMs,
        mutexTimeoutMs,
        clock,
        isAlive,
      });
    },
  };
}
