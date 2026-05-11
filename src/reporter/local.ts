import * as fs from "node:fs";
import * as path from "node:path";
import type {
  BranchSpec,
  FoundIssue,
  IssueSpec,
  RepoSelector,
  Reporter,
} from "./interface.js";
import type { Logger } from "../log/log.js";

export interface LocalReporterOpts {
  runDir: string;
  logger: Logger;
}

interface Layout {
  root: string;
  issues: string;
  infraIssues: string;
  trackingIssues: string;
  branches: string;
}

function layout(runDir: string): Layout {
  const root = path.join(runDir, "local-report");
  return {
    root,
    issues: path.join(root, "issues"),
    infraIssues: path.join(root, "infra-issues"),
    trackingIssues: path.join(root, "tracking-issues"),
    branches: path.join(root, "branches"),
  };
}

function ensure(l: Layout): void {
  for (const p of [l.root, l.issues, l.infraIssues, l.trackingIssues, l.branches]) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function urlForFile(p: string): string {
  return `file://${path.resolve(p)}`;
}

function issueDirFor(l: Layout, kind: IssueSpec["kind"]): string {
  if (kind === "finding") return l.issues;
  if (kind === "infra") return l.infraIssues;
  return l.trackingIssues;
}

function safeFileName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
}

function findExistingIssueFile(dir: string, marker: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) {
      const body = fs.readFileSync(p, "utf8");
      if (markerMatchesAnchored(body, marker)) return p;
    }
  }
  return null;
}

/**
 * Anchored marker matching: the body must contain the marker exactly once,
 * and its position must be on the final non-empty line. This defeats marker
 * smuggling via agent narrative (per security review C3).
 */
function markerMatchesAnchored(body: string, marker: string): boolean {
  const occurrences = body.split(marker).length - 1;
  if (occurrences !== 1) return false;
  const trimmed = body.trimEnd();
  return trimmed.endsWith(marker);
}

export function makeLocalReporter(opts: LocalReporterOpts): Reporter {
  const l = layout(opts.runDir);
  return {
    kind: "local",
    async verifyAccess(): Promise<void> {
      ensure(l);
    },
    async findBranch(name): Promise<{ url: string } | null> {
      const dir = path.join(l.branches, name);
      if (!fs.existsSync(dir)) return null;
      return { url: urlForFile(dir) };
    },
    async pushBranch(spec: BranchSpec): Promise<{ url: string }> {
      ensure(l);
      const dir = path.join(l.branches, spec.name);
      fs.mkdirSync(dir, { recursive: true });
      for (const file of spec.files) {
        const p = path.join(dir, file.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, file.content);
      }
      fs.writeFileSync(
        path.join(dir, "COMMIT_MSG.txt"),
        `${spec.commitMessage}\n\n(base: ${spec.baseBranch})\n`,
      );
      return { url: urlForFile(dir) };
    },
    async findIssueByMarker(marker, _repo: RepoSelector): Promise<FoundIssue | null> {
      const candidates = [l.issues, l.infraIssues];
      for (const dir of candidates) {
        const found = findExistingIssueFile(dir, marker);
        if (found !== null) return { url: urlForFile(found), state: "open" };
      }
      return null;
    },
    async openIssue(spec: IssueSpec): Promise<{ url: string }> {
      ensure(l);
      const dir = issueDirFor(l, spec.kind);
      const filename = `${safeFileName(spec.title)}.md`;
      const p = path.join(dir, filename);
      const labels = spec.labels.length > 0 ? `Labels: ${spec.labels.join(", ")}\n\n` : "";
      const body = `# ${spec.title}\n\n${labels}${spec.body}\n`;
      fs.writeFileSync(p, body);
      return { url: urlForFile(p) };
    },
  };
}
