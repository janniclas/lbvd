# LLM-based Vulnerability Detector (lbvd)

Automated vulnerability scanning for repositories using coding agents.

LLM-based Vulnerability Detector (`lbvd`) runs a two-stage pipeline over the files of a repository:

1. **Stage 1 (finder)** — produces a structured finding (or a "no finding" record).
2. **Stage 2 (exploiter)** — attempts to back the finding with executable evidence (exploit script, then unit test, then theoretical).

Findings are routed to the project's VCS as branches and issues, or written locally.

**New here?** Read [`docs/getting-started.md`](docs/getting-started.md) for a walkthrough from install to your first scan. This README is the flag-and-config reference.

## Install

```bash
npm i -g lbvd
# or run without installing:
npx lbvd --help
```

Requires Node.js ≥ 20. See [Agent authentication](#agent-authentication-authmode) for the Claude credential the CLI needs at runtime.

## Quick start (local mode, no VCS)

```bash
# Create a config that uses local mode (no GitHub/GitLab calls):
cat > lbvd.yaml <<'YAML'
output:
  mode: local
runner:
  kind: sdk              # set to 'fixture' for tests / dry replays
YAML
lbvd scan-all --dry-run
```

## CLI

```
lbvd scan-all      [--config X] [--concurrency N] [--scope ...] [--dry-run] [--run-id ID] [--auth-mode api_key|subscription]
lbvd scan-changes  [same flags]
lbvd resume <run-id>  [--config X] [--auth-mode ...]
lbvd report  <run-id>
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Run completed successfully |
| 1 | Generic error / dispatcher crash |
| 2 | Preflight refused (oversized run on web-sandbox) |
| 3 | Config invalid / missing token / write-access check failed |
| 4 | Run-level wall-clock budget killed |
| 5 | No targets after discovery |
| 6 | Run interrupted by SIGINT or SIGTERM; partial manifest written |

## Substrates

- **DIY-cloud** — run the CLI on your own VM. Recommended above `--concurrency 4` or for runs over 2 hours.
- **Web-sandbox** (Claude Code on the web) — invoke via the slash command at `slash-commands/lbvd.md`. The slash command sets `LBVD_SUBSTRATE=web-sandbox` so the engine enables the preflight gate. **Web-sandbox requires `auth.mode: subscription`** (see below); `api_key` is refused on this substrate because the sandbox ignores `ANTHROPIC_API_KEY`.

## Agent authentication (`auth.mode`)

The two-stage agent pipeline talks to Claude in one of two modes. Pick the one that matches your billing relationship.

| Mode | Required env var | When to use |
|---|---|---|
| `api_key` (default) | `ANTHROPIC_API_KEY` | Pay-per-token Anthropic Console key. DIY-cloud only. |
| `subscription` | `CLAUDE_CODE_OAUTH_TOKEN` | Claude Pro, Max, Team, or Enterprise subscription (any plan that authorizes `claude setup-token`). **Required** on the web-sandbox. |

The engine does not query plan tier; an attempted run on a plan that doesn't support OAuth tokens fails with whatever error the SDK returns.

Selection precedence (highest wins): `--auth-mode <mode>` CLI flag → `LBVD_AUTH_MODE` env var → `auth.mode` in `lbvd.yaml` → default `api_key`.

### Setting up subscription mode

`CLAUDE_CODE_OAUTH_TOKEN` is a long-lived OAuth token minted by Claude Code's `setup-token` helper on a machine that can open a browser:

```bash
# On your laptop (with browser access):
claude setup-token
# Copy the resulting token. On the host where LLM-based Vulnerability Detector runs:
export CLAUDE_CODE_OAUTH_TOKEN="<paste here>"
```

On the web-sandbox the slash command (`slash-commands/lbvd.md`) refuses to start without `CLAUDE_CODE_OAUTH_TOKEN`. Set it in the sandbox env before invoking the slash command.

### ToS posture

Subscription mode uses the same OAuth credential Claude Code itself uses. Anthropic's Terms of Service expect a single user per subscription; treating a personal subscription as a shared / multi-tenant API replacement is out of policy. Use a fair-use approach (one operator, sensible volume) or move to `api_key` for high-volume / multi-tenant deployments.

### `apiKeyHelper` hazard

Claude Code's `apiKeyHelper` (configured in `~/.claude/settings.json`) runs *inside* the agent subprocess after LLM-based Vulnerability Detector's env chokepoint has already filtered the env. The chokepoint cannot see helper-injected credentials. If you've configured an `apiKeyHelper` that returns a different credential than the one LLM-based Vulnerability Detector selected, that helper-injected value is what the SDK will use — and LLM-based Vulnerability Detector will not have masked it in transcripts/logs. Do not configure `apiKeyHelper` on hosts that run LLM-based Vulnerability Detector unless you've verified it returns the same credential.

### Resume semantics

The auth mode chosen at run start is snapshotted into `state.json`. Resuming with a different `auth.mode` aborts with exit 3 (`auth-mode mismatch`). The token *value* may change across resume (e.g., rotation under the same mode) without triggering this gate.

Runs interrupted by SIGINT or SIGTERM (exit code 6) are resumable. The partial manifest written at interrupt time shows which targets completed, which were queued, and which were in-progress. `lbvd resume <run-id>` picks up from the last persisted state.

## Environment variables

| Var | Meaning |
|---|---|
| `GITHUB_TOKEN` | Token for the source repo when `output.mode=vcs` and `vcs.provider=github`. Override the var name via `vcs.source_token_env`. |
| `<EXPLOIT_TOKEN>` | Token for the target repo when `vcs.exploit_target_repo` is set. The env var name is configured via `vcs.exploit_target_token_env`. |
| `ANTHROPIC_API_KEY` | Required by `auth.mode: api_key` (default). Pay-per-token Anthropic Console key. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Required by `auth.mode: subscription`. Mint with `claude setup-token`. |
| `LBVD_AUTH_MODE` | `api_key` or `subscription`. Overrides `auth.mode` in the config; the `--auth-mode` CLI flag overrides this. |
| `LBVD_RUNNER` | `sdk` (default) or `fixture`. Fixture is for tests / dry replays. |
| `LBVD_FIXTURE_SCENARIO` | Fixture scenario directory under `tests/fixtures/canned-agents/`. |
| `LBVD_FIXTURE_ROOT` | Override the fixture corpus root path. |
| `LBVD_ALLOW_FIXTURE_VCS` | Set to `1` to allow `LBVD_RUNNER=fixture` with `output.mode=vcs`. Default: refused with exit 3. |
| `LBVD_SUBSTRATE` | Set to `web-sandbox` to enable preflight gate. The slash command sets this. |
| `LBVD_LIVE_AGENT` | Set to `1` to run the live SDK smoke test (`tests/workflow/sdk-smoke.test.ts`). Costs real tokens. |

## Config keys

| Key | Default | Meaning |
|---|---|---|
| `concurrency` | `4` | Max simultaneous in-flight agent slots. |
| `scan.scope` | `hint+verify` | `hint_only` denies any read other than the hinted file. |
| `budgets.stage1_per_finding_seconds` | `120` | Stage-1 wall-clock cap per target. Over-budget → `failed`. |
| `budgets.stage2_per_finding_seconds` | `600` | Stage-2 wall-clock cap. Over-budget → tier-3 synthesized outcome. |
| `budgets.run_seconds` | `14400` | Run-level cap; aborts in-flight agents on fire. |
| `budgets.app_probe_seconds` | `300` | Wall-clock cap for the one-time application startup probe (FR-17). Over-budget → synthesized `startable: false, failure_reason: "probe_wall_clock_cap"`; the run continues with Tier 1 disabled. |
| `budgets.app_mutex_timeout_seconds` | `120` | How long a Stage 2 agent polls for the live-application mutex before falling back to Tier 2 evidence. |
| `blacklist.disabled_builtins` | `[]` | Built-in groups to disable: `lockfiles`, `vendored`, `build_outputs`, `minified`, `binary_assets`, `generated_code`, `oversized`, `config_files`. |
| `blacklist.patterns` | `[]` | Extra gitignore-style patterns to exclude. |
| `output.mode` | `vcs` | `vcs` or `local`. |
| `runner.kind` | `sdk` | `sdk` (real Claude Agent) or `fixture` (tests). |
| `runner.sdk.model` | `claude-opus-4-7` | Model identifier passed to the SDK. |
| `auth.mode` | `api_key` | Agent authentication mode: `api_key` or `subscription` (see [Agent authentication](#agent-authentication-authmode)). |

## Security note

When `output.mode=vcs` is used against the **source repo**, the branches contain runnable exploits. Anyone with read access to the source repo can read working exploit code. For shared or public repos:

- set `vcs.exploit_target_repo` to a private repo, or
- use `output.mode=local` and review the artifacts on disk.

The default (`exploit_target_repo: ""`) targets the source repo. This suits private-repo deployments; reconfigure for shared repos.

## Layout under `.lbvd/<run-id>/`

- `state.json`, `active.json` — dispatcher state and live agent telemetry.
- `manifest.json`, `manifest.md` — final report (per-target outcomes, counts, token stats, application-startup probe summary).
- `app-probe.json` — canonical result of the FR-17 application-startup probe (written once per run; reused on resume).
- `app-access.lock` — filesystem mutex serializing Stage 2 live-application access (present only while held).
- `probe/` — probe-agent transcript + intermediate `app-probe.json`.
- `targets/<fingerprint>/` — per-target artifacts (finding.json, outcome.json, exploit/test artifacts, transcripts).
- `local-report/` (when `output.mode=local`) — issues and branches as files.

## Development

```bash
npm install
npx tsx ./src/cli.ts --help
npx tsc --noEmit               # strict typecheck
npm test                       # node:test
```

## Re-recording HTTP fixtures

The GitHub reporter contract tests run against a committed corpus of HTTP
transcripts under `tests/fixtures/http/github/`. There are two ways to refresh
the corpus:

1. **Live recorder** (preferred — load-bearing fidelity per architecture
   §10.6): point `scripts/record-http.ts` at a dedicated fixtures repo.
   `scripts/setup-fixtures-repo.sh` provisions the repo and pre-creates
   the labels the reporter expects; minting the fine-grained PAT is
   manual (GitHub exposes no CLI for that). Then:

   ```sh
   LBVD_RECORD_HTTP=1 \
   GITHUB_TOKEN="$LBVD_FIXTURES_GITHUB_TOKEN" \
   LBVD_FIXTURES_REPO=<owner>/<fixtures-repo> \
   npm run record-http:github
   ```

2. **Offline synth fallback** when no token is available — runs without
   network and writes hand-crafted transcripts that approximate what the
   recorder would produce. Use this only when the live recorder cannot run:

   ```sh
   npm run synth-http
   ```

   Synth output is approximate. Replace with real recordings when possible.

The HTTP-replay layer is specified in `plans/implementation.md` §10 (Phase 10);
status and post-MVP backlog notes live in `plans/implementation.md` §0 / §11.

## Documents

- `plans/requirements.md` — the *what*.
- `plans/architecture.md` — the *how*, conceptually.
- `plans/implementation.md` — concrete file paths, schemas, library choices.
- `plans/open-questions.md` — assumptions made during the build that need user input.
