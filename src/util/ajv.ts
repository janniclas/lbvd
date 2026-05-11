import Ajv, { type ValidateFunction } from "ajv";

// strict:false because our schemas use draft-07 keywords like `const` and
// `pattern` plus an `if/then/else` shape that AJV accepts but flags under
// strict mode. The schemas are reviewed manually; the relaxed parser does
// not loosen any *runtime* check (additionalProperties, patterns, enums all
// remain enforced). Keep this comment if you re-enable strict mode.
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });

export interface ValidationFailure {
  field: string;
  message: string;
}

export class AjvValidationError extends Error {
  failures: ValidationFailure[];
  constructor(label: string, failures: ValidationFailure[]) {
    super(`${label}: ${failures.map((f) => `${f.field} ${f.message}`).join("; ")}`);
    this.name = "AjvValidationError";
    this.failures = failures;
  }
}

export function compileValidator<T>(schema: unknown): ValidateFunction<T> {
  return ajv.compile<T>(schema as object);
}

export function runValidator<T>(
  validate: ValidateFunction<T>,
  data: unknown,
  label: string,
): T {
  if (validate(data)) return data as T;
  const failures: ValidationFailure[] = (validate.errors ?? []).map((e) => ({
    field: e.instancePath || "(root)",
    message: e.message ?? "invalid",
  }));
  throw new AjvValidationError(label, failures);
}
