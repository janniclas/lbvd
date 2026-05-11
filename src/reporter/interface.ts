export type RepoSelector = "source" | "exploit_target";

export interface BranchSpec {
  name: string;
  baseBranch: string;
  files: { path: string; content: string }[];
  commitMessage: string;
  targetRepo: RepoSelector;
}

export interface IssueSpec {
  kind: "finding" | "infra" | "tracking";
  title: string;
  body: string;
  labels: string[];
  targetRepo: RepoSelector;
}

export interface FoundIssue {
  url: string;
  state: "open" | "closed";
}

export interface Reporter {
  kind: "local" | "github" | "gitlab";
  verifyAccess(): Promise<void>;
  findBranch(name: string, repo: RepoSelector): Promise<{ url: string } | null>;
  pushBranch(spec: BranchSpec): Promise<{ url: string }>;
  findIssueByMarker(marker: string, repo: RepoSelector): Promise<FoundIssue | null>;
  openIssue(spec: IssueSpec): Promise<{ url: string }>;
}
