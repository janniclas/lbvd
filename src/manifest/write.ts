import * as fs from "node:fs";
import * as path from "node:path";
import type { Clock } from "../clock/clock.js";
import type { Redactor } from "../redaction/redact.js";
import type { RunState } from "../dispatcher/state.js";
import { buildManifest } from "./build.js";
import { renderManifestMarkdown } from "./render-md.js";

export interface WriteOpts {
  runDir: string;
  state: RunState;
  clock: Clock;
  redactor?: Redactor;
}

export function writeManifest(opts: WriteOpts): void {
  const m = buildManifest(opts);
  fs.writeFileSync(path.join(opts.runDir, "manifest.json"), JSON.stringify(m, null, 2));
  fs.writeFileSync(path.join(opts.runDir, "manifest.md"), renderManifestMarkdown(m));
}
