import type { ResolvedConfig } from "../config/defaults.js";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../log/log.js";
import type { Reporter } from "./interface.js";
import { makeLocalReporter } from "./local.js";
import { makeGithubReporter } from "./github.js";

export interface SelectReporterOpts {
  config: ResolvedConfig;
  runDir: string;
  logger: Logger;
  clock: Clock;
}

export function selectReporter(opts: SelectReporterOpts): Reporter {
  if (opts.config.output.mode === "local") {
    return makeLocalReporter({ runDir: opts.runDir, logger: opts.logger });
  }
  if (opts.config.vcs.provider === "github") {
    return makeGithubReporter({
      config: opts.config,
      runDir: opts.runDir,
      logger: opts.logger,
      clock: opts.clock,
    });
  }
  throw new Error(`reporter: provider ${opts.config.vcs.provider} not supported in MVP (GitLab is post-MVP).`);
}
