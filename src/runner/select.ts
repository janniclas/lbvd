import type { ResolvedConfig } from "../config/defaults.js";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../log/log.js";
import type { Redactor } from "../redaction/redact.js";
import { makeFixtureRunner } from "./fixture-runner.js";
import { makeSdkRunner } from "./sdk-runner.js";
import type { Runner } from "./interface.js";

export interface SelectOpts {
  config: ResolvedConfig;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  logger: Logger;
  redactor?: Redactor;
}

export function selectRunner(opts: SelectOpts): Runner {
  const envOverride = opts.env["LBVD_RUNNER"];
  const kind = envOverride === "fixture" || envOverride === "sdk" ? envOverride : opts.config.runner.kind;
  if (kind === "fixture") {
    return makeFixtureRunner({ clock: opts.clock, ...(opts.redactor !== undefined && { redactor: opts.redactor }) });
  }
  return makeSdkRunner({
    config: opts.config,
    clock: opts.clock,
    logger: opts.logger,
    ...(opts.redactor !== undefined && { redactor: opts.redactor }),
  });
}
