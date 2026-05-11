import type { ResolvedConfig } from "../config/defaults.js";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../log/log.js";
import type {
  BranchSpec,
  FoundIssue,
  IssueSpec,
  RepoSelector,
  Reporter,
} from "./interface.js";
import { httpJson, HttpError } from "./http.js";

export interface GithubReporterOpts {
  config: ResolvedConfig;
  runDir: string;
  logger: Logger;
  clock: Clock;
}

interface RepoRef {
  full: string;
  baseBranch: string;
  tokenEnv: string;
}

function selectorToRepo(opts: GithubReporterOpts, sel: RepoSelector): RepoRef {
  if (sel === "exploit_target" && opts.config.vcs.exploit_target_repo.length > 0) {
    return {
      full: opts.config.vcs.exploit_target_repo,
      baseBranch: opts.config.vcs.default_branch,
      tokenEnv: opts.config.vcs.exploit_target_token_env,
    };
  }
  return {
    full: opts.config.vcs.repo,
    baseBranch: opts.config.vcs.default_branch,
    tokenEnv: opts.config.vcs.source_token_env,
  };
}

function tokenFor(repo: RepoRef): string {
  const t = process.env[repo.tokenEnv];
  if (t === undefined || t.length === 0) {
    throw new Error(`github: env ${repo.tokenEnv} is not set`);
  }
  return t;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "lbvd/0.1",
    "Content-Type": "application/json",
  };
}

function branchUrl(repo: RepoRef, name: string): string {
  return `https://github.com/${repo.full}/tree/${encodeURIComponent(name)}`;
}

async function getRefSha(repo: RepoRef, ref: string, token: string): Promise<string | null> {
  try {
    const res = await httpJson({
      method: "GET",
      url: `https://api.github.com/repos/${repo.full}/git/ref/heads/${encodeURIComponent(ref)}`,
      headers: ghHeaders(token),
    });
    const body = res.body as { object?: { sha?: string } };
    return body.object?.sha ?? null;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

async function createBlob(repo: RepoRef, content: string, token: string): Promise<string> {
  const res = await httpJson({
    method: "POST",
    url: `https://api.github.com/repos/${repo.full}/git/blobs`,
    headers: ghHeaders(token),
    body: { content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" },
  });
  return (res.body as { sha: string }).sha;
}

async function createTree(
  repo: RepoRef,
  baseTreeSha: string,
  entries: { path: string; sha: string }[],
  token: string,
): Promise<string> {
  const tree = entries.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.sha }));
  const res = await httpJson({
    method: "POST",
    url: `https://api.github.com/repos/${repo.full}/git/trees`,
    headers: ghHeaders(token),
    body: { base_tree: baseTreeSha, tree },
  });
  return (res.body as { sha: string }).sha;
}

async function createCommit(
  repo: RepoRef,
  message: string,
  treeSha: string,
  parentSha: string,
  token: string,
): Promise<string> {
  const res = await httpJson({
    method: "POST",
    url: `https://api.github.com/repos/${repo.full}/git/commits`,
    headers: ghHeaders(token),
    body: { message, tree: treeSha, parents: [parentSha] },
  });
  return (res.body as { sha: string }).sha;
}

async function createBranch(repo: RepoRef, name: string, sha: string, token: string): Promise<void> {
  await httpJson({
    method: "POST",
    url: `https://api.github.com/repos/${repo.full}/git/refs`,
    headers: ghHeaders(token),
    body: { ref: `refs/heads/${name}`, sha },
  });
}

async function pushBranchImpl(repo: RepoRef, spec: BranchSpec, token: string): Promise<void> {
  const baseSha = await getRefSha(repo, repo.baseBranch, token);
  if (baseSha === null) {
    throw new Error(`github: base branch ${repo.baseBranch} not found in ${repo.full}`);
  }
  const baseCommitRes = await httpJson({
    method: "GET",
    url: `https://api.github.com/repos/${repo.full}/git/commits/${baseSha}`,
    headers: ghHeaders(token),
  });
  const baseTreeSha = ((baseCommitRes.body as { tree: { sha: string } }).tree).sha;
  const blobs = await Promise.all(
    spec.files.map(async (f) => ({ path: f.path, sha: await createBlob(repo, f.content, token) })),
  );
  const treeSha = await createTree(repo, baseTreeSha, blobs, token);
  const commitSha = await createCommit(repo, spec.commitMessage, treeSha, baseSha, token);
  await createBranch(repo, spec.name, commitSha, token);
}

interface IssueSearchResult {
  total_count: number;
  items: { html_url: string; state: "open" | "closed" }[];
}

async function searchIssueByMarker(
  repo: RepoRef,
  marker: string,
  token: string,
): Promise<FoundIssue | null> {
  // GitHub search has a 256-char limit; the marker is short.
  // - The marker contains `<`, `:`, `-->` which the search parser rejects as
  //   bare tokens (422) — wrap in double quotes for an exact-phrase match.
  // - The endpoint now requires `is:issue` or `is:pull-request`; without
  //   either, GitHub returns 422 ("Query must include 'is:issue' or
  //   'is:pull-request'"). We always want issues here.
  const q = `"${marker}" in:body is:issue repo:${repo.full}`;
  const res = await httpJson({
    method: "GET",
    url: `https://api.github.com/search/issues?q=${encodeURIComponent(q)}`,
    headers: ghHeaders(token),
  });
  const body = res.body as IssueSearchResult;
  if (body.total_count === 0 || body.items.length === 0) return null;
  const first = body.items[0]!;
  return { url: first.html_url, state: first.state };
}

async function createIssue(repo: RepoRef, spec: IssueSpec, token: string): Promise<{ url: string }> {
  const res = await httpJson({
    method: "POST",
    url: `https://api.github.com/repos/${repo.full}/issues`,
    headers: ghHeaders(token),
    body: { title: spec.title, body: spec.body, labels: spec.labels },
  });
  return { url: (res.body as { html_url: string }).html_url };
}

async function verifyRepoAccess(repo: RepoRef, token: string): Promise<void> {
  const res = await httpJson({
    method: "GET",
    url: `https://api.github.com/repos/${repo.full}`,
    headers: ghHeaders(token),
  });
  const body = res.body as { permissions?: { push?: boolean } };
  if (body.permissions?.push !== true) {
    throw new Error(`github: token lacks push permission on ${repo.full}`);
  }
}

export function makeGithubReporter(opts: GithubReporterOpts): Reporter {
  const sourceRepo = (): RepoRef => selectorToRepo(opts, "source");
  const exploitRepo = (): RepoRef => selectorToRepo(opts, "exploit_target");
  const repoFor = (s: RepoSelector): RepoRef =>
    s === "exploit_target" && opts.config.vcs.exploit_target_repo.length > 0 ? exploitRepo() : sourceRepo();

  return {
    kind: "github",
    async verifyAccess(): Promise<void> {
      const src = sourceRepo();
      await verifyRepoAccess(src, tokenFor(src));
      if (opts.config.vcs.exploit_target_repo.length > 0) {
        const tgt = exploitRepo();
        await verifyRepoAccess(tgt, tokenFor(tgt));
      }
    },
    async findBranch(name, sel): Promise<{ url: string } | null> {
      const repo = repoFor(sel);
      return { url: branchUrl(repo, name) };
    },
    async pushBranch(spec): Promise<{ url: string }> {
      const repo = repoFor(spec.targetRepo);
      const tok = tokenFor(repo);
      const existing = await getRefSha(repo, spec.name, tok);
      if (existing !== null) {
        return { url: branchUrl(repo, spec.name) };
      }
      await pushBranchImpl(repo, spec, tok);
      return { url: branchUrl(repo, spec.name) };
    },
    async findIssueByMarker(marker, sel): Promise<FoundIssue | null> {
      const repo = repoFor(sel);
      return searchIssueByMarker(repo, marker, tokenFor(repo));
    },
    async openIssue(spec): Promise<{ url: string }> {
      const repo = repoFor(spec.targetRepo);
      return createIssue(repo, spec, tokenFor(repo));
    },
  };
}
