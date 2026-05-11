import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Logger } from "../log/log.js";
import type { RunState } from "./state.js";
import { isValidFingerprint } from "../util/safe-path.js";

function pendingDirFor(runDir: string, target: string): string {
  const sha1 = crypto.createHash("sha1").update(target).digest("hex").slice(0, 12);
  return path.join(runDir, "targets", "_pending", sha1);
}

function targetSubtree(runDir: string, fingerprint: string): string {
  return path.join(runDir, "targets", fingerprint);
}

function rmIfExists(p: string): void {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

export function reconcileResume(runDir: string, state: RunState, logger: Logger): RunState {
  for (const [target, t] of Object.entries(state.targets)) {
    if (t.state === "stage1_running") {
      rmIfExists(pendingDirFor(runDir, target));
      t.state = "queued";
      t.stage1_started_at = null;
      logger.info("resume.demoted", { target, from: "stage1_running", to: "queued" });
    } else if (t.state === "stage2_running" && isValidFingerprint(t.fingerprint)) {
      const subtree = targetSubtree(runDir, t.fingerprint);
      for (const name of ["outcome.json", "exploit.sh", "exploit.py", "exploit.js", "unit-test.ts", "unit-test.js", "unit-test.py"]) {
        rmIfExists(path.join(subtree, name));
      }
      logger.info("resume.preserved_finding", { target, fingerprint: t.fingerprint });
    }
    // reporting_* states keep their state; pipeline.ts handles re-entry
  }
  sweepPendingOrphans(runDir, state, logger);
  return state;
}

function sweepPendingOrphans(runDir: string, state: RunState, logger: Logger): void {
  const pendingRoot = path.join(runDir, "targets", "_pending");
  if (!fs.existsSync(pendingRoot)) return;
  const known = new Set<string>();
  for (const target of Object.keys(state.targets)) {
    const t = state.targets[target]!;
    if (t.state !== "queued" && t.state !== "stage1_running") continue;
    const sha1 = crypto.createHash("sha1").update(target).digest("hex").slice(0, 12);
    known.add(sha1);
  }
  const orphansRoot = path.join(runDir, "targets", "_orphans");
  for (const name of fs.readdirSync(pendingRoot)) {
    if (!known.has(name)) {
      fs.mkdirSync(orphansRoot, { recursive: true });
      const suffix = crypto.randomBytes(4).toString("hex");
      const dest = path.join(orphansRoot, `${name}.${suffix}`);
      fs.renameSync(path.join(pendingRoot, name), dest);
      logger.info("resume.orphan_swept", { sha1: name, moved_to: dest });
    }
  }
}
