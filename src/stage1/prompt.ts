/**
 * Stage-1 system prompt. The agent reads the target file (and possibly
 * supporting context per scan scope) and writes a strict-schema
 * `finding.json` into its working directory before exiting.
 *
 * Capability gating is enforced by `sdk-tool-shim.ts`; the prompt is
 * advisory. Don't rely on prompt obedience for security.
 */
import * as path from "node:path";

export interface Stage1PromptOpts {
  targetFile: string;      // relative path — used in finding.json output
  targetFilePath: string;  // absolute path — used for the read instruction
  scanScope: "hint_only" | "hint+verify" | "repo_wide";
}

export function stage1SystemPrompt(opts: Stage1PromptOpts): string {
  if (!path.isAbsolute(opts.targetFilePath)) {
    throw new Error(`stage1SystemPrompt: targetFilePath must be absolute, got '${opts.targetFilePath}'`);
  }
  return `You are LLM-based Vulnerability Detector Stage 1 — the read-only finder.

You are scanning ${opts.targetFilePath} for a single most-likely vulnerability.
You have read access. You may not run shell commands or fetch from the network.

When done, write your verdict to ./finding.json (in your working directory)
with this exact JSON shape and exit:

{
  "schema_version": 1,
  "fingerprint": "<12 lowercase hex chars>",
  "status": "vulnerability" | "no_finding",
  "target_file": "${opts.targetFile}",
  "category": "<short kebab-case category>",
  "severity_self_rated": "low" | "medium" | "high",   // required when status=vulnerability
  "location": { "start_line": <int>, "end_line": <int> }, // required when status=vulnerability
  "narrative": "<2–6 sentence root-cause description>",   // required when status=vulnerability
  "no_finding_reason": "<one sentence>",                  // required when status=no_finding
  "stage1_token_usage": { "input": 0, "output": 0 }       // host overrides; you may write 0
}

Compute fingerprint as the first 12 chars of sha256("<category>\\n" + <normalized
snippet>) where the snippet is the vulnerable lines with comments stripped and
whitespace collapsed. The fingerprint must match /^[0-9a-f]{12}$/.

Rules:
- Pick the single most-likely concrete bug. Be conservative; emit "no_finding"
  if you cannot articulate one.
- Do not invent file paths. Do not include extra fields.
- Scan scope is "${opts.scanScope}". For "hint_only", do NOT read other files.
`;
}
