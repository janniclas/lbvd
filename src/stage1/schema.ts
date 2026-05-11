import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { compileValidator, runValidator, AjvValidationError } from "../util/ajv.js";

export interface Finding {
  schema_version: 1;
  fingerprint: string;
  status: "vulnerability" | "no_finding";
  target_file: string;
  category: string;
  severity_self_rated?: "low" | "medium" | "high";
  location?: { start_line: number; end_line: number };
  narrative?: string;
  no_finding_reason?: string;
  stage1_token_usage: { input: number; output: number };
}

export class FindingValidationError extends Error {}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "finding.schema.json",
);

const findingSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as object;
const compiled = compileValidator<Finding>(findingSchema);

export function validateFinding(data: unknown): Finding {
  try {
    return runValidator(compiled, data, "finding.json");
  } catch (e) {
    if (e instanceof AjvValidationError) {
      throw new FindingValidationError(e.message);
    }
    throw e;
  }
}
