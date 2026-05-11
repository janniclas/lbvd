import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import { setTransportForTesting, makeReplayTransport } from "../../src/reporter/http.js";
import { makeGithubReporter } from "../../src/reporter/github.js";
import { makeLocalReporter } from "../../src/reporter/local.js";
import { findingMarker } from "../../src/reporter/issue-body.js";
import { branchName } from "../../src/reporter/branch-name.js";
import { systemClock } from "../../src/clock/clock.js";
import { nullLogger } from "../../src/log/log.js";
import { DEFAULT_CONFIG, type ResolvedConfig } from "../../src/config/defaults.js";
import type { Reporter, BranchSpec, IssueSpec } from "../../src/reporter/interface.js";

const REPO = "janniclas/lbvd-fixtures";
const FINGERPRINT = "c0ffeec0ffee";
const BRANCH = branchName(1, FINGERPRINT);
const MARKER = findingMarker(FINGERPRINT);

function repoRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

function makeConfig(): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    vcs: {
      ...DEFAULT_CONFIG.vcs,
      provider: "github",
      repo: REPO,
      default_branch: "main",
      source_token_env: "GITHUB_TOKEN",
      exploit_target_repo: "",
      exploit_target_token_env: "",
    },
    output: { mode: "vcs", local_dir: ".lbvd/local-report" },
  };
}

const branchSpec: BranchSpec = {
  name: BRANCH,
  baseBranch: "main",
  files: [
    { path: "exploit.sh", content: "#!/bin/sh\necho 'pwned'\n" },
    { path: "README.md",  content: "# LLM-based Vulnerability Detector finding\n\nDeterministic recording fixture.\n" },
  ],
  commitMessage: "lbvd: code_injection_eval evidence",
  targetRepo: "source",
};

const issueSpec: IssueSpec = {
  kind: "finding",
  title: "[LBVD] code_injection_eval in eval.js",
  body: [
    "# code_injection_eval",
    "",
    "Recorder fixture for LBVD contract tests. Auto-closed after record runs.",
    "",
    MARKER,
  ].join("\n"),
  labels: ["lbvd", "priority:high", "tier:1"],
  targetRepo: "source",
};

interface ScenarioResult {
  branchUrl: string;
  issueUrl: string;
  rePushUrl: string;
  hitUrl: string | null;
  hitState: "open" | "closed" | null;
}

async function runScenario(reporter: Reporter): Promise<ScenarioResult> {
  await reporter.verifyAccess();
  const miss = await reporter.findIssueByMarker(MARKER, "source");
  assert.equal(miss, null, "expected first findIssueByMarker to miss");
  const branchRes = await reporter.pushBranch(branchSpec);
  const issueRes = await reporter.openIssue(issueSpec);
  const rePushRes = await reporter.pushBranch(branchSpec);
  const hit = await reporter.findIssueByMarker(MARKER, "source");
  return {
    branchUrl: branchRes.url,
    issueUrl: issueRes.url,
    rePushUrl: rePushRes.url,
    hitUrl: hit?.url ?? null,
    hitState: hit?.state ?? null,
  };
}

test("reporter-contract: Local + GitHub-replay produce equivalent reporter behavior (architecture §10)", async () => {
  // Replay corpus must be loaded before any HTTP call. The token is required
  // because tokenFor() reads env at call time, but its value is irrelevant —
  // the replay transport ignores Authorization headers.
  const prevToken = process.env.GITHUB_TOKEN;
  // Sentinel value that doesn't match any forge-PAT pattern, so it won't be
  // flagged by secret scanners. Replay ignores Authorization entirely.
  process.env.GITHUB_TOKEN = "replay-only-not-a-real-token";

  const corpusDir = path.join(repoRoot(), "tests", "fixtures", "http", "github");
  setTransportForTesting(makeReplayTransport(corpusDir));

  let ghResult: ScenarioResult;
  let localResult: ScenarioResult;
  try {
    const ghReporter = makeGithubReporter({
      config: makeConfig(),
      runDir: fs.mkdtempSync(path.join(os.tmpdir(), "lbvd-eq-gh-")),
      logger: nullLogger,
      clock: systemClock,
    });
    ghResult = await runScenario(ghReporter);

    const localRunDir = fs.mkdtempSync(path.join(os.tmpdir(), "lbvd-eq-loc-"));
    const localReporter = makeLocalReporter({ runDir: localRunDir, logger: nullLogger });
    localResult = await runScenario(localReporter);
  } finally {
    setTransportForTesting(null);
    if (prevToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = prevToken;
    }
  }

  // Both reporters returned non-empty URLs.
  assert.ok(ghResult.branchUrl.length > 0, "github branch URL");
  assert.ok(ghResult.issueUrl.length > 0, "github issue URL");
  assert.ok(localResult.branchUrl.length > 0, "local branch URL");
  assert.ok(localResult.issueUrl.length > 0, "local issue URL");

  // Idempotent re-push returns the same URL as the original push (architecture §5.4).
  assert.equal(ghResult.rePushUrl, ghResult.branchUrl, "github idempotent re-push");
  assert.equal(localResult.rePushUrl, localResult.branchUrl, "local idempotent re-push");

  // Second findIssueByMarker hits with state "open".
  assert.notEqual(ghResult.hitUrl, null, "github findIssueByMarker hit");
  assert.equal(ghResult.hitState, "open");
  assert.notEqual(localResult.hitUrl, null, "local findIssueByMarker hit");
  assert.equal(localResult.hitState, "open");

  // URL shape differs by reporter — that's expected (substrate split).
  assert.match(ghResult.branchUrl, /^https:\/\/github\.com\//);
  assert.match(ghResult.issueUrl, /^https:\/\/github\.com\//);
  assert.match(localResult.branchUrl, /^file:\/\//);
  assert.match(localResult.issueUrl, /^file:\/\//);
});
