import { redact } from "../redaction/redact.js";

/**
 * Pre-logger stderr emission. Used only in the boot path (cli.ts, dispatcher
 * setup, fixture-VCS guard) where the structured logger is not yet wired.
 *
 * SECURITY (sec review L2 / post-impl L1): `redact()` here is the
 * *module-level* redactor — regex-set only, **no per-run literal mask**. The
 * resolved auth credential (FR-15) is not in scope at this layer. Callers
 * must therefore never embed a user secret in `msg` — error messages should
 * reference env var **names**, not values. For any post-startup emission
 * where the per-run `Redactor` is available, use `Logger.info` / `Logger.debug`
 * instead; they apply the threaded redactor including literals.
 */
export function safeStderr(msg: string): void {
  process.stderr.write(redact(msg));
}
