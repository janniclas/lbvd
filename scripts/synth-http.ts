#!/usr/bin/env tsx
/**
 * One-shot generator for synthetic HTTP transcripts.
 *
 * Used to seed `tests/fixtures/http/github/` when the live recorder
 * (scripts/record-http.ts) cannot run for an offline development session.
 * The output approximates what the recorder would produce against the
 * fixtures repo with a clean starting state. **Synth is a fallback, not the
 * source of truth** — the live recorder is the load-bearing fidelity
 * guarantee for FR-7 / architecture §10.6. Replace these with real
 * recordings whenever possible.
 *
 * Output: tests/fixtures/http/github/*.json
 *
 * **Filename scheme.** Synth uses `NN-name.json` numeric prefixes; the live
 * recorder uses `${METHOD}${urlSlug}_${key}[_${seq}].json`. Both schemes work
 * because `loadCorpus` only requires a stable sort within a single corpus.
 * Don't mix the two — running the live recorder wipes the corpus dir via
 * `fs.rmSync({ force: true })` before writing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { findingMarker } from "../src/reporter/issue-body.js";
import { branchName } from "../src/reporter/branch-name.js";

const REPO = "janniclas/lbvd-fixtures";
const FINGERPRINT = "c0ffeec0ffee";
const BRANCH = branchName(1, FINGERPRINT);
const BRANCH_ENC = encodeURIComponent(BRANCH);
const MARKER = findingMarker(FINGERPRINT);
const ISSUE_TITLE = "[LBVD] code_injection_eval in eval.js";
const ISSUE_BODY = [
  "# code_injection_eval",
  "",
  "Recorder fixture for LBVD contract tests. Auto-closed after record runs.",
  "",
  MARKER,
].join("\n");
const COMMIT_MESSAGE = "lbvd: code_injection_eval evidence";
const FILES = [
  { path: "exploit.sh", content: "#!/bin/sh\necho 'pwned'\n" },
  { path: "README.md",  content: "# LLM-based Vulnerability Detector finding\n\nDeterministic recording fixture.\n" },
];

const MAIN_BASE_SHA = "0000000000000000000000000000000000000a01";
const MAIN_BASE_TREE_SHA = "0000000000000000000000000000000000000b01";
const BLOB_EXPLOIT_SHA = "0000000000000000000000000000000000000b10";
const BLOB_README_SHA = "0000000000000000000000000000000000000b11";
const NEW_TREE_SHA = "0000000000000000000000000000000000000b20";
const NEW_COMMIT_SHA = "0000000000000000000000000000000000000a02";
const ISSUE_NUMBER = 42;

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

const baseUrl = `https://api.github.com/repos/${REPO}`;
const searchUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(`"${MARKER}" in:body is:issue repo:${REPO}`)}`;
const issueUrl = `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`;
const headers = { "content-type": "application/json; charset=utf-8" };
const branchRefUrl = `${baseUrl}/git/ref/heads/${BRANCH_ENC}`;

interface Transcript {
  request: { method: string; url: string; body: unknown };
  response: { status: number; body: unknown; headers: Record<string, string> };
}

const transcripts: { name: string; t: Transcript }[] = [
  {
    name: "01-verify-access.json",
    t: {
      request: { method: "GET", url: baseUrl, body: null },
      response: {
        status: 200,
        body: { full_name: REPO, permissions: { push: true, pull: true, admin: false } },
        headers,
      },
    },
  },
  {
    name: "02-search-issues-miss.json",
    t: {
      request: { method: "GET", url: searchUrl, body: null },
      response: {
        status: 200,
        body: { total_count: 0, incomplete_results: false, items: [] },
        headers,
      },
    },
  },
  {
    name: "03-get-ref-heads-branch-404.json",
    t: {
      request: { method: "GET", url: branchRefUrl, body: null },
      response: {
        status: 404,
        body: { message: "Not Found", documentation_url: "https://docs.github.com/rest" },
        headers,
      },
    },
  },
  {
    name: "04-get-ref-heads-main.json",
    t: {
      request: { method: "GET", url: `${baseUrl}/git/ref/heads/main`, body: null },
      response: {
        status: 200,
        body: { ref: "refs/heads/main", object: { sha: MAIN_BASE_SHA, type: "commit" } },
        headers,
      },
    },
  },
  {
    name: "05-get-base-commit.json",
    t: {
      request: { method: "GET", url: `${baseUrl}/git/commits/${MAIN_BASE_SHA}`, body: null },
      response: {
        status: 200,
        body: { sha: MAIN_BASE_SHA, tree: { sha: MAIN_BASE_TREE_SHA }, parents: [] },
        headers,
      },
    },
  },
  {
    name: "06-create-blob-exploit.json",
    t: {
      request: {
        method: "POST",
        url: `${baseUrl}/git/blobs`,
        body: { content: b64(FILES[0]!.content), encoding: "base64" },
      },
      response: { status: 201, body: { sha: BLOB_EXPLOIT_SHA }, headers },
    },
  },
  {
    name: "07-create-blob-readme.json",
    t: {
      request: {
        method: "POST",
        url: `${baseUrl}/git/blobs`,
        body: { content: b64(FILES[1]!.content), encoding: "base64" },
      },
      response: { status: 201, body: { sha: BLOB_README_SHA }, headers },
    },
  },
  {
    name: "08-create-tree.json",
    t: {
      request: {
        method: "POST",
        url: `${baseUrl}/git/trees`,
        body: {
          base_tree: MAIN_BASE_TREE_SHA,
          tree: [
            { path: "exploit.sh", mode: "100644", type: "blob", sha: BLOB_EXPLOIT_SHA },
            { path: "README.md",  mode: "100644", type: "blob", sha: BLOB_README_SHA  },
          ],
        },
      },
      response: { status: 201, body: { sha: NEW_TREE_SHA }, headers },
    },
  },
  {
    name: "09-create-commit.json",
    t: {
      request: {
        method: "POST",
        url: `${baseUrl}/git/commits`,
        body: { message: COMMIT_MESSAGE, tree: NEW_TREE_SHA, parents: [MAIN_BASE_SHA] },
      },
      response: { status: 201, body: { sha: NEW_COMMIT_SHA }, headers },
    },
  },
  {
    name: "10-create-ref.json",
    t: {
      request: {
        method: "POST",
        url: `${baseUrl}/git/refs`,
        body: { ref: `refs/heads/${BRANCH}`, sha: NEW_COMMIT_SHA },
      },
      response: {
        status: 201,
        body: { ref: `refs/heads/${BRANCH}`, object: { sha: NEW_COMMIT_SHA, type: "commit" } },
        headers,
      },
    },
  },
  {
    name: "11-create-issue.json",
    t: {
      request: {
        method: "POST",
        url: `${baseUrl}/issues`,
        body: {
          title: ISSUE_TITLE,
          body: ISSUE_BODY,
          labels: ["lbvd", "priority:high", "tier:1"],
        },
      },
      response: {
        status: 201,
        body: { html_url: issueUrl, number: ISSUE_NUMBER, state: "open" },
        headers,
      },
    },
  },
  {
    name: "12-get-ref-heads-branch-200.json",
    t: {
      request: { method: "GET", url: branchRefUrl, body: null },
      response: {
        status: 200,
        body: { ref: `refs/heads/${BRANCH}`, object: { sha: NEW_COMMIT_SHA, type: "commit" } },
        headers,
      },
    },
  },
  {
    name: "13-search-issues-hit.json",
    t: {
      request: { method: "GET", url: searchUrl, body: null },
      response: {
        status: 200,
        body: {
          total_count: 1,
          incomplete_results: false,
          items: [{ html_url: issueUrl, state: "open", number: ISSUE_NUMBER }],
        },
        headers,
      },
    },
  },
];

function main(): void {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const dir = path.join(repoRoot, "tests", "fixtures", "http", "github");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const { name, t } of transcripts) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(t, null, 2) + "\n");
  }
  process.stderr.write(
    `synth: ${transcripts.length} transcripts written to ${path.relative(repoRoot, dir)}\n`,
  );
}

main();
