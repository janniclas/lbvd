import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { compileValidator, runValidator, AjvValidationError } from "../util/ajv.js";

export interface Outcome {
  schema_version: 1;
  fingerprint: string;
  tier: 1 | 2 | 3;
  tier_claim: 1 | 2 | 3;
  confidence: number;
  exploit_artifact_path: string | null;
  test_artifact_path: string | null;
  execution_record:
    | { exit_code: number; captured_output: string; ran_at: string }
    | null;
  infra_requirements:
    | { needed: string[]; attempted: string[]; runner_environment: { os: string; arch: string } }
    | null;
  exploit_targets_application?: boolean | null;
  downgrade_reason: string | null;
  stage2_token_usage: { input: number; output: number };
  stage2_wall_seconds: number;
}

export class OutcomeValidationError extends Error {}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "outcome.schema.json",
);

const outcomeSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as object;
const compiled = compileValidator<Outcome>(outcomeSchema);

export function validateOutcome(data: unknown): Outcome {
  try {
    return runValidator(compiled, data, "outcome.json");
  } catch (e) {
    if (e instanceof AjvValidationError) {
      throw new OutcomeValidationError(e.message);
    }
    throw e;
  }
}
