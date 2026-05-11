import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { compileValidator, runValidator, AjvValidationError } from "../util/ajv.js";

export interface AppProbe {
  schema_version: 1;
  startable: boolean;
  start_commands: string[];
  stop_commands: string[];
  port: number | null;
  health_check_url: string | null;
  startup_timeout_seconds: number;
  pre_conditions: string[];
  probe_narrative: string;
  tried: boolean;
  successfully_started: boolean;
  failure_reason: string | null;
  probe_token_usage: { input: number; output: number };
  probe_wall_seconds: number;
}

export class AppProbeValidationError extends Error {}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "app-probe.schema.json",
);

const probeSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as object;
const compiled = compileValidator<AppProbe>(probeSchema);

export function validateAppProbe(data: unknown): AppProbe {
  try {
    return runValidator(compiled, data, "app-probe.json");
  } catch (e) {
    if (e instanceof AjvValidationError) {
      throw new AppProbeValidationError(e.message);
    }
    throw e;
  }
}

/**
 * Confirm `start_commands` and `stop_commands` are non-empty string arrays.
 * Architecture §22.3: the dispatcher revalidates the probe output before
 * passing the commands to a Stage 2 agent so a jailbroken probe cannot
 * inject malformed or shell-laden values that bypass the schema.
 */
export function hasNonEmptyCommandArrays(p: AppProbe): boolean {
  return (
    Array.isArray(p.start_commands) &&
    p.start_commands.length > 0 &&
    p.start_commands.every((c) => typeof c === "string" && c.length > 0) &&
    Array.isArray(p.stop_commands) &&
    p.stop_commands.length > 0 &&
    p.stop_commands.every((c) => typeof c === "string" && c.length > 0)
  );
}
