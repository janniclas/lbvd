import type { ResolvedConfig } from "../config/defaults.js";
import { enumerate } from "./enumerate.js";
import { redact } from "../redaction/redact.js";

export interface DryRunOpts {
  mode: "scan-all" | "scan-changes";
  cwd: string;
  config: ResolvedConfig;
}

export async function runDryRun(opts: DryRunOpts): Promise<number> {
  const list = await enumerate({ mode: opts.mode, cwd: opts.cwd, config: opts.config });
  for (const t of list.targets) {
    process.stdout.write(redact(`${t}\n`));
  }
  for (const ex of list.exclusions) {
    process.stderr.write(redact(`excluded\t${ex.layer}\t${ex.path}\n`));
  }
  if (list.targets.length === 0) {
    process.stderr.write("0 targets\n");
  }
  return 0;
}
