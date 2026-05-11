import type { Finding } from "../stage1/schema.js";
import type { Outcome } from "../stage2/schema.js";
import type { RoutingResult } from "../routing/route.js";

export function findingMarker(fingerprint: string): string {
  return `<!-- lbvd:fp:${fingerprint} -->`;
}

export function infraMarker(fingerprint: string): string {
  return `<!-- lbvd:fp:${fingerprint}:infra -->`;
}

/**
 * Strip HTML-comment delimiters from agent-controlled strings before they are
 * inlined into issue bodies. The marker contract (architecture §11.2) requires
 * exactly one marker per issue; an unsanitized narrative could smuggle a
 * spoofed marker and hijack `findIssueByMarker` lookups.
 */
function sanitizeMarkdownComment(s: string): string {
  return s.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
}

export interface FindingBodyInput {
  finding: Finding;
  outcome: Outcome;
  routing: RoutingResult;
  branchUrl: string | null;
  runId: string;
}

function fenceCode(content: string): string {
  return "```\n" + content + "\n```";
}

function formatLocation(f: Finding): string {
  if (f.location === undefined) return f.target_file;
  return `${f.target_file}:${f.location.start_line}-${f.location.end_line}`;
}

function tierReason(t: 1 | 2 | 3): string {
  if (t === 1) return "tier 1: working exploit";
  if (t === 2) return "tier 2: unit test / PoC";
  return "tier 3: theoretical";
}

export function renderFindingIssueBody(input: FindingBodyInput): string {
  const f = input.finding;
  const o = input.outcome;
  const r = input.routing;
  const lines: string[] = [];
  lines.push(`# ${sanitizeMarkdownComment(f.category)}`);
  lines.push("");
  lines.push(`**Priority:** ${r.priority} (${tierReason(o.tier)})`);
  lines.push(`**Severity (self-rated):** ${f.severity_self_rated ?? "n/a"}`);
  lines.push(`**Confidence:** ${o.confidence}`);
  lines.push(`**Bump applied:** ${sanitizeMarkdownComment(r.bumpReason)}`);
  lines.push(`**Location:** ${sanitizeMarkdownComment(formatLocation(f))}`);
  lines.push(`**Branch:** ${input.branchUrl ?? "n/a"}`);
  lines.push(`**Run id:** ${input.runId}`);
  lines.push("");
  lines.push("## Vulnerability narrative");
  lines.push(sanitizeMarkdownComment(f.narrative ?? ""));
  lines.push("");
  lines.push("## Reproduction");
  if (o.tier === 1 && o.exploit_artifact_path !== null) {
    lines.push(`Run the exploit script at \`${sanitizeMarkdownComment(o.exploit_artifact_path)}\` from the branch.`);
  } else if (o.tier === 2 && o.test_artifact_path !== null) {
    lines.push(`Add and run the unit test at \`${sanitizeMarkdownComment(o.test_artifact_path)}\` from the branch.`);
  } else if (o.tier === 2 && o.exploit_artifact_path !== null) {
    lines.push(`Run the proof-of-concept exploit at \`${sanitizeMarkdownComment(o.exploit_artifact_path)}\` from the branch.`);
  } else {
    lines.push("No executable artifact (theoretical finding).");
  }
  if (o.execution_record !== null) {
    lines.push("");
    lines.push("### Execution record");
    lines.push(`- Exit code: ${o.execution_record.exit_code}`);
    lines.push(`- Ran at: ${sanitizeMarkdownComment(o.execution_record.ran_at)}`);
    lines.push("");
    lines.push("Captured output:");
    lines.push(fenceCode(sanitizeMarkdownComment(o.execution_record.captured_output)));
  }
  lines.push("");
  lines.push(findingMarker(f.fingerprint));
  return lines.join("\n");
}

export interface InfraBodyInput {
  finding: Finding;
  outcome: Outcome;
  runId: string;
}

export function renderInfraIssueBody(input: InfraBodyInput): string {
  const infra = input.outcome.infra_requirements;
  const lines: string[] = [];
  lines.push(`# Infrastructure required for ${sanitizeMarkdownComment(input.finding.category)}`);
  lines.push("");
  lines.push(`**Run id:** ${input.runId}`);
  lines.push(`**Source finding:** ${sanitizeMarkdownComment(input.finding.target_file)}`);
  if (infra !== null) {
    lines.push("");
    lines.push("## Needed");
    for (const n of infra.needed) lines.push(`- ${sanitizeMarkdownComment(n)}`);
    lines.push("");
    lines.push("## Attempted");
    for (const n of infra.attempted) lines.push(`- ${sanitizeMarkdownComment(n)}`);
    lines.push("");
    lines.push("## Runner environment");
    lines.push(`- OS: ${sanitizeMarkdownComment(infra.runner_environment.os)}`);
    lines.push(`- Arch: ${sanitizeMarkdownComment(infra.runner_environment.arch)}`);
  }
  lines.push("");
  lines.push(infraMarker(input.finding.fingerprint));
  return lines.join("\n");
}

export interface TrackingBodyInput {
  findingIssueUrl: string;
  finding: Finding;
  runId: string;
}

export function renderTrackingIssueBody(input: TrackingBodyInput): string {
  return [
    `Tracking issue for ${input.finding.target_file}.`,
    "",
    `Finding details: ${input.findingIssueUrl}`,
    "",
    `Run id: ${input.runId}`,
  ].join("\n");
}
