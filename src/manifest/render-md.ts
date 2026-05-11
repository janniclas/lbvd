import type { Manifest, ManifestAppProbe } from "./build.js";

function fmtCounts(c: Manifest["counts_by_tier"]): string {
  return `tier1=${c.tier1}, tier2=${c.tier2}, tier3=${c.tier3}, no_finding=${c.no_finding}, failed=${c.failed}`;
}

function renderAppProbe(probe: ManifestAppProbe | null): string {
  if (probe === null) return "Probe did not complete.";
  if (probe.startable) {
    return `✓ Application startable — ${probe.probe_narrative} (${probe.probe_wall_seconds.toFixed(1)}s).`;
  }
  return `✗ Application not startable — ${probe.probe_narrative}.`;
}

function tableRow(o: Manifest["outcomes"][number]): string {
  const url = o.issue_url ?? o.branch_url ?? "n/a";
  return `| ${o.target_file} | ${o.state} | ${o.tier ?? "—"} | ${o.priority ?? "—"} | ${o.confidence ?? "—"} | ${url} |`;
}

export function renderManifestMarkdown(m: Manifest): string {
  const lines: string[] = [];
  lines.push(`# LLM-based Vulnerability Detector run ${m.run_id}`);
  lines.push("");
  lines.push(`- Started: ${m.started_at}`);
  lines.push(`- Ended: ${m.ended_at ?? "—"}`);
  lines.push(`- Targets: ${m.total_files}`);
  lines.push(`- Concurrency: ${m.concurrency}`);
  lines.push("");
  lines.push("## Counts by tier");
  lines.push(fmtCounts(m.counts_by_tier));
  lines.push("");
  lines.push("## Counts by per-target state");
  for (const [k, v] of Object.entries(m.counts_by_outcome)) {
    lines.push(`- ${k}: ${v}`);
  }
  lines.push("");
  lines.push("## Severity self-rating distribution");
  lines.push(`- low: ${m.severity_self_rated_distribution.low}`);
  lines.push(`- medium: ${m.severity_self_rated_distribution.medium}`);
  lines.push(`- high: ${m.severity_self_rated_distribution.high}`);
  lines.push("");
  lines.push("## Severity × Tier crosstab");
  for (const sev of ["low", "medium", "high"] as const) {
    const r = m.severity_vs_tier_crosstab[sev];
    lines.push(`- ${sev}: tier1=${r.tier1}, tier2=${r.tier2}, tier3=${r.tier3}`);
  }
  lines.push("");
  lines.push("## Outcomes");
  lines.push("| target | state | tier | priority | confidence | url |");
  lines.push("|---|---|---|---|---|---|");
  for (const o of m.outcomes) lines.push(tableRow(o));
  lines.push("");
  lines.push("## Token usage");
  const overall = m.token_usage.overall.aggregates;
  lines.push(`Overall (input+output) min=${overall.min} median=${overall.median} mean=${overall.mean.toFixed(1)} p90=${overall.p90} p95=${overall.p95} max=${overall.max}`);
  lines.push("");
  lines.push("## Wall-clock");
  lines.push(`- run_seconds: ${m.wall_clock_totals.run_seconds.toFixed(1)}`);
  lines.push("");
  lines.push("## Application Startup");
  lines.push(renderAppProbe(m.app_probe));
  lines.push("");
  if (m.terminations.length > 0) {
    lines.push("## Terminations");
    for (const t of m.terminations) {
      const sig = "signal" in t && t.signal !== undefined ? ` (${t.signal})` : "";
      lines.push(`- ${t.kind}${sig} @ ${t.at}: ${t.reason}`);
    }
    lines.push("");
  }
  if (m.errors.length > 0) {
    lines.push("## Errors");
    for (const e of m.errors) lines.push(`- ${e.target_file}: ${e.error}`);
  }
  return lines.join("\n") + "\n";
}
