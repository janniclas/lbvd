# Getting Started with LLM-based Vulnerability Detector

A walkthrough from zero to your first scan. We'll set things up so
results land as files on your disk — the simplest mode, perfect for
seeing what LLM-based Vulnerability Detector produces before deciding how to use it.

When you're ready for more, see:

- [Reporting to GitHub](workflows/github-reporting.md) — push findings as
  issues and exploit branches.
- [Running from Claude Code on the web](workflows/web-sandbox.md) — use
  the slash command instead of the CLI.

This guide does not cover developing LLM-based Vulnerability Detector itself; see `README.md`
for the reference of every flag, env var, and config key.

---

## What LLM-based Vulnerability Detector does

You point it at a git repository. It walks every source file, runs an
agent that hunts for vulnerabilities, and for anything it finds it runs
a second agent that tries to produce a runnable exploit or a failing
unit test. You get back a manifest summarizing what it found.

It does not modify your source code. All scan artifacts live under
`.lbvd/` (which you should add to `.gitignore`).

---

## Before you begin

You need:

- **Node.js 20 or newer** on your machine.
- **A git repository** to scan — your own code is the intended use case.
- **A way to pay Anthropic for the agent work** — an Anthropic Console
  API key, or a Claude.ai subscription (Pro, Max, Team, or Enterprise).

---

## Install

```bash
git clone <this repository's URL>
cd lbvd
npm install
```

There's no build step — LLM-based Vulnerability Detector runs TypeScript directly.

---

## Step 1: Set up your Claude credential

LLM-based Vulnerability Detector runs in one of two authentication modes. Pick one.

### Option A — API key (pay-per-token)

You have an Anthropic Console API key. Each scan costs whatever its
token usage adds up to.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

`api_key` is the default mode, so no further config is needed.

### Option B — Claude subscription (fixed quota)

You have a Claude.ai subscription on the Pro, Max, Team, or Enterprise
plan. Scans draw from your subscription quota instead of billing
per-token.

Mint a long-lived OAuth token once, on a machine that can open a
browser:

```bash
# On your laptop, in a terminal:
claude setup-token
# Follow the browser flow, then copy the resulting token.
```

On the machine where LLM-based Vulnerability Detector will run:

```bash
export CLAUDE_CODE_OAUTH_TOKEN="<paste the token here>"
```

Tell LLM-based Vulnerability Detector to use subscription mode. The most portable way is the
config file (`lbvd.yaml`, see Step 2):

```yaml
auth:
  mode: subscription
```

You can also use the `--auth-mode subscription` flag or the
`LBVD_AUTH_MODE=subscription` environment variable for a one-off
override. Precedence is flag → env → config file.

**Two notes on subscription terms:**

- Anthropic's Terms of Service expect a single user per subscription —
  treating it as a multi-tenant API replacement is out of policy. Use
  subscription mode for your own work on your own repos. For
  high-volume or multi-tenant deployments, use `api_key`.
- If your machine has a `~/.claude/settings.json` with an `apiKeyHelper`
  configured, the helper runs inside the agent subprocess and can
  override the credential LLM-based Vulnerability Detector selected. LLM-based Vulnerability Detector cannot mask
  helper-injected credentials in its logs and transcripts. If you've
  configured one, verify it returns the credential you intend
  LLM-based Vulnerability Detector to use — or remove it on hosts that run LLM-based Vulnerability Detector.

---

## Step 2: Create your config file

Make a file called `lbvd.yaml` at the root of the repo you want
to scan. For your first scan, use local mode — findings are written as
files under `.lbvd/<run-id>/local-report/`, with no calls to
GitHub or GitLab. The minimum config is:

```yaml
output:
  mode: local
```

Add `auth.mode: subscription` if you're using Option B above.

Add `.lbvd/` to your `.gitignore` so you don't accidentally commit
scan artifacts:

```bash
echo ".lbvd/" >> .gitignore
```

When you're ready to publish findings as GitHub issues and branches,
switch to vcs mode — see
[workflows/github-reporting.md](workflows/github-reporting.md).

---

## Step 3: Dry-run

A dry-run resolves which files LLM-based Vulnerability Detector would scan and exits. No
agents run, no money or quota is spent.

```bash
npx tsx /path/to/lbvd/src/cli.ts scan-all --dry-run
```

You'll see a list of files. If something you expected is missing — or
something you didn't expect is included — tune the blacklist (see
"Tuning what gets scanned" below) and try again.

---

## Step 4: Run the scan

```bash
npx tsx /path/to/lbvd/src/cli.ts scan-all
```

You'll see structured log lines as the agents work through the targets.
Each finding goes through two agents (finder, then exploiter), so a run
takes wall-clock time roughly proportional to your target count divided
by the configured concurrency (default 4).

When the run finishes, LLM-based Vulnerability Detector writes a final manifest and exits.

---

## Step 5: Read the manifest

The run identifier is printed in the logs and is also the directory
name under `.lbvd/`. Open the human-readable manifest:

```bash
open .lbvd/<run-id>/manifest.md
```

Or print it to your terminal:

```bash
npx tsx /path/to/lbvd/src/cli.ts report <run-id>
```

The manifest summarizes each scanned file's outcome:

| Outcome | Meaning |
|---|---|
| **Tier 1** | Vulnerability confirmed with a runnable exploit script. Highest priority. |
| **Tier 2** | Vulnerability confirmed with a failing unit test. |
| **Tier 3** | Theoretical or unsubstantiated finding — the exploiter couldn't back it. |
| **No finding** | The finder agent didn't see a vulnerability. |
| **Failed** | An agent crashed or hit its wall-clock budget. |

For each finding, the manifest links to the per-target subtree under
`.lbvd/<run-id>/targets/<fingerprint>/`, which contains the
agent's transcripts and any exploit script or unit test the agents
produced.

---

## Choosing what to scan

Three subcommands cover the common cases.

### `scan-all` — every source file in the repo

```bash
npx tsx /path/to/lbvd/src/cli.ts scan-all
```

The full sweep. Use this for a first audit of an unfamiliar codebase
or periodic re-scans. LLM-based Vulnerability Detector skips files that match its built-in
blacklist (lockfiles, vendored code, build outputs, minified files,
binary assets, generated code, oversized files, config files) and any
patterns you've added.

### `scan-changes` — only what you've staged

```bash
git add path/to/changed-file.ts
npx tsx /path/to/lbvd/src/cli.ts scan-changes
```

Same scanner, limited to the files currently staged for commit. Good
for a pre-commit check on a focused change.

### `resume <run-id>` — pick up where you left off

If a scan was interrupted (you killed it, your laptop slept, a budget
fired), resume continues from the persisted state:

```bash
npx tsx /path/to/lbvd/src/cli.ts resume <run-id>
```

A resumed run is idempotent: previously published issues and branches
aren't republished, and per-target state is reconciled before agents
restart.

You can't resume a run with a different `auth.mode` than it started
with — LLM-based Vulnerability Detector will refuse with an "auth-mode mismatch" error. The
token *value* may change between runs (e.g., you rotated your API
key); that's fine.

---

## Tuning what gets scanned

Default blacklist groups are on already (lockfiles, vendored, build
outputs, minified, binary assets, generated code, oversized, config
files). To turn a group off:

```yaml
blacklist:
  disabled_builtins:
    - config_files
```

To add your own exclusion patterns (gitignore syntax):

```yaml
blacklist:
  patterns:
    - "vendor/**"
    - "**/*.generated.ts"
```

To restrict how far the finder agent can read while scanning a single
file, set `scan.scope`:

- `hint_only` — the finder can read only the file it was assigned.
  Most conservative; fastest.
- `hint+verify` — the finder can read the rest of the repo to verify
  what it sees. Default.
- `repo_wide` — the finder can roam freely. Most thorough; slowest.

---

## Troubleshooting

### Exit code 3, "missing credential"

You didn't export `ANTHROPIC_API_KEY` (api_key mode) or
`CLAUDE_CODE_OAUTH_TOKEN` (subscription mode). Re-read [Step 1](#step-1-set-up-your-claude-credential).
The error names the env var that's missing and the corrective action.

### Exit code 4

The run-level wall-clock budget fired. Bump `budgets.run_seconds` in
your config, or scope the scan down with `scan-changes` or blacklist
patterns.

### Exit code 5

No targets matched after the blacklist filter. Either your repo really
has nothing to scan, or your blacklist is too aggressive. Run
`scan-all --dry-run` to see what's being filtered out.

### Exit codes at a glance

| Code | Meaning |
|---|---|
| 0 | Run completed successfully. |
| 1 | Generic error / crash. |
| 2 | Substrate preflight refused (size or wrong auth mode in the web sandbox — see [workflows/web-sandbox.md](workflows/web-sandbox.md)). |
| 3 | Config invalid, missing credential, or write-access check failed. |
| 4 | Run-level wall-clock budget killed the run. |
| 5 | No targets after discovery. |

---

## Where to go from here

- **Publish findings to GitHub** — see
  [workflows/github-reporting.md](workflows/github-reporting.md).
- **Run from Claude Code on the web** — see
  [workflows/web-sandbox.md](workflows/web-sandbox.md).
- **Reference for every config key, env var, and flag** — see
  `README.md`.
- **Inspect a specific finding** — open the per-target subtree at
  `.lbvd/<run-id>/targets/<fingerprint>/`. The agent's transcript
  and any generated artifact (exploit script, unit test) live there.
  Transcripts are redacted — no tokens leak — but otherwise
  full-fidelity.
