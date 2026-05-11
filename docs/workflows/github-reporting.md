# Reporting Findings to GitHub

This guide assumes you've completed [`docs/getting-started.md`](../getting-started.md)
and want to switch from local files to publishing findings as GitHub
issues and branches.

---

## What changes

When you switch from `output.mode: local` to `output.mode: vcs`:

- Each finding becomes a **GitHub issue** in the configured repo, with
  a description, the routing tier, and a hidden marker the resume path
  uses to avoid duplicates.
- Each **Tier 1** finding (where the agent produced a runnable
  exploit) also gets a **branch** pushed with the exploit script
  committed to it. Branch names are derived deterministically from the
  finding's fingerprint, so re-runs don't create duplicates.
- LLM-based Vulnerability Detector verifies it can write to your target repo *before*
  spending any agent tokens. A missing or under-scoped token aborts
  the run with exit code 3 immediately, so you don't pay for a scan
  whose results you can't publish.

---

## Set up your token

Create a GitHub personal access token with `repo` scope. A fine-grained
PAT scoped to the target repo with read+write on **Contents** and
**Issues** also works.

```bash
export GITHUB_TOKEN="ghp_..."
```

---

## Configure

Edit `lbvd.yaml`:

```yaml
output:
  mode: vcs
vcs:
  provider: github
  repo: your-org/your-repo
  default_branch: main
```

Then run as usual:

```bash
lbvd scan-all
```

---

## Security note: branches contain runnable exploits

When LLM-based Vulnerability Detector pushes to the same repo as the source code, **anyone
with read access to your repo can read working exploit code**. For a
private repo with a small team, that's usually the point — your team
needs to see the exploits to triage them. For shared or public repos,
this is a leak.

You have two options.

### Option 1 — Keep findings in a separate (private) repo

Use a sensitive-repo split. Findings + exploits land in a private
"security-findings" repo only your security team can read. A link-only
tracking issue is filed in the source repo so contributors know an
issue exists without seeing the exploit.

```yaml
output:
  mode: vcs
vcs:
  provider: github
  repo: public-org/public-repo
  default_branch: main
  exploit_target_repo: private-org/security-findings
  exploit_target_token_env: SECURITY_GITHUB_TOKEN
```

Export both tokens before running:

```bash
export GITHUB_TOKEN="<source-repo token>"
export SECURITY_GITHUB_TOKEN="<exploit-target-repo token>"
```

The source-repo token only needs Issues write; the
`SECURITY_GITHUB_TOKEN` needs Contents + Issues write on the private
repo.

### Option 2 — Stay in local mode

If you don't want to publish exploits anywhere, use
`output.mode: local` and review findings on disk. See
[`docs/getting-started.md`](../getting-started.md).

---

## Troubleshooting

### Exit code 3, "reporter access check failed"

Your token is missing, expired, or doesn't have permission to write to
the target repo. Check the token's scopes — the `repo` scope or its
fine-grained equivalent must include Contents and Issues write. If
you're using a sensitive-repo split, both tokens are checked.

### Duplicate issues showing up after a re-scan

Shouldn't happen — LLM-based Vulnerability Detector's resume path uses a hidden marker in
the issue body to recognize re-encounters. If you see duplicates,
check whether you ran with a different `auth.mode` (which forces a new
run rather than a resume) or whether the markers were stripped by a
GitHub Action / bot that edits issue bodies.

### A branch was pushed but no issue was opened

The branch push is the first reporter step for a Tier-1 finding; the
issue follow. If the run was killed between the two, `resume` will
finish the issue side without re-pushing the branch.

---

## Back to the basics

- [Getting started](../getting-started.md) — install, first scan,
  local mode.
- [Running from Claude Code on the web](web-sandbox.md) — same
  publishing flow, different host.
- `README.md` — full config and flag reference.
