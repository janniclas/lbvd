import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedConfig } from "../config/defaults.js";
import type { Substrate } from "./detect.js";

export interface PreflightOpts {
  targets: string[];
  cwd: string;
  config: ResolvedConfig;
  substrate: Substrate;
}

export type PreflightResult = { ok: true } | { ok: false; reason: string };

export function preflight(opts: PreflightOpts): PreflightResult {
  if (opts.config.preflight.enabled_on_substrate !== opts.substrate) {
    return { ok: true };
  }
  // FR-15 / architecture §20.4: web sandbox is subscription-only. The
  // auth-mode gate fires before size checks so an operator with the wrong
  // mode learns immediately regardless of repo size.
  if (opts.substrate === "web-sandbox" && opts.config.auth.mode === "api_key") {
    return {
      ok: false,
      reason:
        "web sandbox requires auth.mode: subscription; ANTHROPIC_API_KEY is ignored in this substrate. " +
        "Run 'claude setup-token' and export CLAUDE_CODE_OAUTH_TOKEN, or set auth.mode: subscription.",
    };
  }
  const maxTargets = opts.config.preflight.max_targets;
  if (opts.targets.length > maxTargets) {
    return {
      ok: false,
      reason: `target count ${opts.targets.length} exceeds preflight.max_targets=${maxTargets}.`,
    };
  }
  let total = 0;
  const limit = opts.config.preflight.max_tree_bytes;
  for (const rel of opts.targets) {
    try {
      const stat = fs.statSync(path.join(opts.cwd, rel));
      total += stat.size;
      if (total > limit) {
        return {
          ok: false,
          reason: `total size > preflight.max_tree_bytes=${limit}.`,
        };
      }
    } catch {
      /* missing file is treated as zero */
    }
  }
  return { ok: true };
}
