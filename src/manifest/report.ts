import * as fs from "node:fs";
import * as path from "node:path";
import { systemClock } from "../clock/clock.js";
import { loadState } from "../dispatcher/state.js";
import { buildManifest } from "./build.js";
import { renderManifestMarkdown } from "./render-md.js";
import { redact } from "../redaction/redact.js";
import { safeStderr } from "../util/safe-stderr.js";

export interface ReportOpts {
  runId: string;
  cwd: string;
}

export async function runReport(opts: ReportOpts): Promise<number> {
  const runDir = path.join(opts.cwd, ".lbvd", opts.runId);
  if (!fs.existsSync(path.join(runDir, "state.json"))) {
    safeStderr(`lbvd: run-id ${opts.runId} not found at ${runDir}\n`);
    return 1;
  }
  const state = loadState(runDir);
  const manifest = buildManifest({ runDir, state, clock: systemClock });
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const md = renderManifestMarkdown(manifest);
  fs.writeFileSync(path.join(runDir, "manifest.md"), md);
  process.stdout.write(redact(md));
  return 0;
}
