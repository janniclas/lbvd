#!/usr/bin/env tsx
/**
 * Re-record HTTP transcripts for the GitHub reporter contract tests.
 *
 * Provision the fixtures repo with `scripts/setup-fixtures-repo.sh`, mint a
 * fine-grained PAT scoped to that repo (Contents + Issues: write), then:
 *
 *   LBVD_RECORD_HTTP=1 \
 *   GITHUB_TOKEN="$LBVD_FIXTURES_GITHUB_TOKEN" \
 *   LBVD_FIXTURES_REPO=<owner>/<fixtures-repo> \
 *   npm run record-http:github
 *
 * Output: tests/fixtures/http/github/*.json
 *
 * The script:
 *   - pre-cleans the fixtures repo (deletes the recorder branch, closes any
 *     open issue carrying the recorder fingerprint marker),
 *   - probes the token via a verifyAccess call before recording (catches a
 *     forgotten/expired PAT loudly, before half a transcript is written),
 *   - drives the GitHub reporter through a deterministic scenario covering
 *     verifyAccess, pushBranch (full git-data sequence), openIssue,
 *     idempotent re-push, and findIssueByMarker (miss + hit),
 *   - tears down the artifacts it created.
 *
 * Cleanup uses raw undici calls so the cleanup traffic is NOT captured in the
 * recorded corpus. The `scripts/` carve-out for direct `undici` access (per
 * lint-boundaries.ts) is documented in lessons-learned.md.
 *
 * **Body-redaction discipline.** The recording transport persists request and
 * response bodies as-is (only response headers are stripped to a content-type
 * allowlist). The recorder must not be invoked on a scenario whose bodies
 * could contain secrets. The fixtures repo is dedicated test target — this
 * keeps the blast radius scoped to the operator's own non-sensitive metadata.
 *
 * **Filename scheme.** The live recorder produces
 * `${METHOD}${urlSlug}_${key}[_${seq}].json`; the offline synth fallback
 * (`scripts/synth-http.ts`) uses `NN-name.json` numeric prefixes. Both
 * schemes work because `loadCorpus` only requires a stable sort within a
 * single corpus. Don't mix the two — re-running the live recorder wipes
 * synth output via `fs.rmSync(corpusDir, { force: true })`.
 */
import * as path from "node:path";
import * as fs from "node:fs";
import { request as undiciRequest } from "undici";

import { makeGithubReporter } from "../src/reporter/github.js";
import { setTransportForTesting, makeRecordingTransport } from "../src/reporter/http.js";
import { systemClock } from "../src/clock/clock.js";
import { nullLogger } from "../src/log/log.js";
import { DEFAULT_CONFIG, type ResolvedConfig } from "../src/config/defaults.js";
import { findingMarker } from "../src/reporter/issue-body.js";
import { branchName } from "../src/reporter/branch-name.js";

const FINGERPRINT = "c0ffeec0ffee";
const BRANCH = branchName(1, FINGERPRINT);
const MARKER = findingMarker(FINGERPRINT);
const ISSUE_TITLE = "[LBVD] code_injection_eval in eval.js";
const ISSUE_BODY = [
  "# code_injection_eval",
  "",
  "Recorder fixture for LBVD contract tests. Auto-closed after record runs.",
  "",
  MARKER,
].join("\n");

const FILES = [
  { path: "exploit.sh", content: "#!/bin/sh\necho 'pwned'\n" },
  { path: "README.md",  content: "# LLM-based Vulnerability Detector finding\n\nDeterministic recording fixture.\n" },
];

function envOrThrow(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`required env: ${name}`);
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "lbvd-recorder/0.1",
    "Content-Type": "application/json",
  };
}

interface RawResp {
  status: number;
  body: unknown;
}

async function rawApi(opts: {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  body?: unknown;
  token: string;
}): Promise<RawResp> {
  const undiciOpts: Parameters<typeof undiciRequest>[1] = {
    method: opts.method,
    headers: authHeaders(opts.token),
  };
  if (opts.body !== undefined) {
    undiciOpts.body = JSON.stringify(opts.body);
  }
  const res = await undiciRequest(opts.url, undiciOpts);
  const text = await res.body.text();
  let body: unknown = text;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch { /* keep text */ }
  }
  return { status: res.statusCode, body };
}

async function deleteBranchIfExists(repo: string, branch: string, token: string): Promise<void> {
  const res = await rawApi({
    method: "DELETE",
    url: `https://api.github.com/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    token,
  });
  if (![204, 404, 422].includes(res.status)) {
    throw new Error(`cleanup: DELETE branch ${branch}: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

async function closeOpenIssuesWithMarker(repo: string, marker: string, token: string): Promise<number> {
  const q = encodeURIComponent(`${marker} in:body repo:${repo} state:open`);
  const res = await rawApi({
    method: "GET",
    url: `https://api.github.com/search/issues?q=${q}`,
    token,
  });
  const items = (res.body as { items?: { number: number }[] }).items ?? [];
  for (const item of items) {
    await rawApi({
      method: "PATCH",
      url: `https://api.github.com/repos/${repo}/issues/${item.number}`,
      body: { state: "closed" },
      token,
    });
  }
  return items.length;
}

async function probeToken(repo: string, token: string): Promise<void> {
  const res = await rawApi({
    method: "GET",
    url: `https://api.github.com/repos/${repo}`,
    token,
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `recorder: token rejected by GitHub (${res.status}). Mint a fresh fine-grained PAT scoped to the fixtures repo with Contents + Issues: write.`,
    );
  }
  if (res.status !== 200) {
    throw new Error(`recorder: probe of ${repo} returned ${res.status} (expected 200)`);
  }
}

async function preCleanup(repo: string, token: string): Promise<void> {
  await probeToken(repo, token);
  await deleteBranchIfExists(repo, BRANCH, token);
  const closed = await closeOpenIssuesWithMarker(repo, MARKER, token);
  process.stderr.write(`recorder: pre-cleanup closed ${closed} issue(s); waiting for search index\n`);
  await sleep(8000);
}

async function postCleanup(
  repo: string,
  token: string,
  issueNumber: number | null,
): Promise<void> {
  await deleteBranchIfExists(repo, BRANCH, token);
  if (issueNumber !== null) {
    await rawApi({
      method: "PATCH",
      url: `https://api.github.com/repos/${repo}/issues/${issueNumber}`,
      body: { state: "closed" },
      token,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeConfig(repo: string): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    vcs: {
      ...DEFAULT_CONFIG.vcs,
      provider: "github",
      repo,
      default_branch: "main",
      source_token_env: "GITHUB_TOKEN",
      exploit_target_repo: "",
      exploit_target_token_env: "",
    },
    output: { mode: "vcs", local_dir: ".lbvd/local-report" },
  };
}

function issueNumberFromUrl(url: string): number | null {
  const m = /\/issues\/(\d+)$/.exec(url);
  return m !== null ? parseInt(m[1]!, 10) : null;
}

async function recordScenario(repoRoot: string, repo: string): Promise<number | null> {
  const corpusDir = path.join(repoRoot, "tests", "fixtures", "http", "github");
  fs.rmSync(corpusDir, { recursive: true, force: true });
  fs.mkdirSync(corpusDir, { recursive: true });

  setTransportForTesting(makeRecordingTransport(corpusDir));
  try {
    const config = makeConfig(repo);
    const runDir = path.join(repoRoot, ".lbvd-recorder", "scratch");
    fs.mkdirSync(runDir, { recursive: true });
    const reporter = makeGithubReporter({
      config,
      runDir,
      logger: nullLogger,
      clock: systemClock,
    });

    process.stderr.write("recorder: verifyAccess\n");
    await reporter.verifyAccess();

    process.stderr.write("recorder: findIssueByMarker (miss)\n");
    const miss = await reporter.findIssueByMarker(MARKER, "source");
    if (miss !== null) {
      throw new Error(`recorder: expected miss, got ${miss.url}`);
    }

    process.stderr.write("recorder: pushBranch (initial)\n");
    const spec = {
      name: BRANCH,
      baseBranch: "main",
      files: FILES,
      commitMessage: "lbvd: code_injection_eval evidence",
      targetRepo: "source" as const,
    };
    const branchRes = await reporter.pushBranch(spec);
    process.stderr.write(`recorder: branch=${branchRes.url}\n`);

    process.stderr.write("recorder: openIssue\n");
    const issueRes = await reporter.openIssue({
      kind: "finding",
      title: ISSUE_TITLE,
      body: ISSUE_BODY,
      labels: ["lbvd", "priority:high", "tier:1"],
      targetRepo: "source",
    });
    process.stderr.write(`recorder: issue=${issueRes.url}\n`);

    process.stderr.write("recorder: pushBranch (idempotent re-push)\n");
    await reporter.pushBranch(spec);

    process.stderr.write("recorder: waiting for search index\n");
    await sleep(8000);

    process.stderr.write("recorder: findIssueByMarker (hit)\n");
    const hit = await reporter.findIssueByMarker(MARKER, "source");
    if (hit === null) {
      throw new Error("recorder: expected hit, got null (search index may be slow; rerun)");
    }

    return issueNumberFromUrl(issueRes.url);
  } finally {
    setTransportForTesting(null);
  }
}

async function main(): Promise<void> {
  if (process.env.LBVD_RECORD_HTTP !== "1") {
    process.stderr.write("LBVD_RECORD_HTTP=1 is required (safety gate).\n");
    process.exit(2);
  }
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const repo = envOrThrow("LBVD_FIXTURES_REPO", "janniclas/lbvd-fixtures");
  const token = envOrThrow(
    "GITHUB_TOKEN",
    process.env.LBVD_FIXTURES_GITHUB_TOKEN,
  );
  process.env.GITHUB_TOKEN = token;

  process.stderr.write(`recorder: target ${repo}\n`);
  await preCleanup(repo, token);

  let issueNumber: number | null = null;
  try {
    issueNumber = await recordScenario(repoRoot, repo);
  } finally {
    process.stderr.write("recorder: post-cleanup\n");
    await postCleanup(repo, token, issueNumber);
  }

  const corpusDir = path.join(repoRoot, "tests", "fixtures", "http", "github");
  const count = fs.readdirSync(corpusDir).filter((n) => n.endsWith(".json")).length;
  process.stderr.write(
    `recorder: ${count} transcripts written to ${path.relative(repoRoot, corpusDir)}\n`,
  );
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.stack ?? e.message : String(e);
  process.stderr.write(`recorder: ${msg}\n`);
  process.exit(1);
});
