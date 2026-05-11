/**
 * Strip ANSI escape sequences and collapse line breaks. Used for any
 * agent-controlled string that reaches a terminal write, a markdown
 * artefact, or a one-line label (commit subjects, status messages).
 * Defaults to a 200-character cap for one-line use; callers handling
 * narrative-length text pass a larger cap.
 *
 * The chokepoint exists because the redactor (`src/redaction/`) handles
 * known token literals + regex patterns but not control bytes; a
 * jailbroken agent can otherwise plant `\x1B[2J` etc. in fields like
 * `finding.category`, `outcome.downgrade_reason`, `probe.failure_reason`
 * and `probe.probe_narrative` that surface in operator-visible channels.
 */
export function sanitizeOneLine(s: string, maxLen = 200): string {
  return s
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\r\n\t\v\f]+/g, " ")
    .replace(/[\x00-\x08\x0E-\x1F\x7F]/g, "")
    .slice(0, maxLen);
}
