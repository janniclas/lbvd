# LLM-based Vulnerability Detector — Requirements

This document captures *what* LLM-based Vulnerability Detector must do — the requirements, features, acceptance criteria, and supported user workflows. Architectural and technical decisions live in `architecture.md`; concrete implementation details (file paths, function signatures, schemas, library choices) live in `implementation.md`.

## 1. Context

LLM-based Vulnerability Detector is an automated vulnerability-scanning system for source code repositories. It runs a two-stage agent pipeline over a target codebase:

- A **finder** stage proposes the most serious vulnerability per file.
- An **exploiter** stage attempts to produce runnable proof of the finding.

Findings are routed into the project's VCS as branches and issues, with the strength of the proof determining the priority and the artifact set. The system is triggerable from a Claude Code on the web session (so the user can let it run overnight without an open laptop) and as a standalone CLI on a user-managed VM (DIY-cloud) for cases that exceed sandbox limits.

## 2. Glossary

- **Run** — one invocation of LLM-based Vulnerability Detector (`scan-all` or `scan-changes`).
- **Target file** — a file selected for scanning.
- **Finding** — stage 1's structured output describing one vulnerability (or a "no vulnerability found" record) for one file.
- **Tier 1 / exploit** — stage 2 produced runnable code that demonstrates the vulnerability when executed.
- **Tier 2 / unit test or PoC** — stage 2 produced either a unit test that asserts on the unwanted behavior, or a proof-of-concept exploit that demonstrates the vulnerability in isolation (without targeting the running application).
- **Tier 3 / theoretical** — stage 2 could neither exploit nor test; the finding stands on stage 1's reasoning alone.
- **Fingerprint** — a stable per-finding identifier used for deduplication across files and runs. The fingerprint computation, the hidden HTML-comment marker, and resume-time reconciliation by marker are implemented; *initial-open* across-run dedup (skip if a marker-matching open issue exists) is post-MVP (FR-8).

## 3. Goals & Non-goals

**Goals**

- Two-stage agent pipeline (find → exploit/test) over a repo, with a configurable concurrency cap.
- Two scan modes: `scan-all` (all tracked files) and `scan-changes` (staged files only).
- Outputs landed in the project's VCS (GitHub or GitLab) as branches and issues — or, optionally, in a local-only mode that produces the same content as files on disk.
- Triggerable as a `/lbvd` slash command from Claude Code on the web *and* as a standalone CLI for DIY-cloud runs.
- Resumable across sandbox/VM restarts; safe to re-run without producing duplicate or orphan artifacts.
- Two agent-authentication modes: an Anthropic Console **API key** (pay-per-token) and a **Claude subscription** OAuth token (fixed quota — Pro / Max / Team / Enterprise). The operator chooses; both modes drive the same pipeline.

**Non-goals (v1)**

- Authoring fixes for the vulnerabilities (issues + branches only; no PR with a patch).
- Cross-host PR creation, code review comments, or CI integration.
- Languages/frameworks beyond what the agent can already reason about — the system is content-agnostic and relies on the agent's general code skills.
- Real-time UI dashboard. A run produces a final manifest and per-agent transcripts.
- Completion notifications (email, webhook, summary issue). The manifest is the deliverable; the user polls. The system is designed so a notifier can be bolted on later, but no notifier ships in v1.

## 4. Supported workflows

| ID  | Workflow                | What the user does                                                                                                                                                                       |
|-----|-------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| W1  | `scan-all`              | Invokes the CLI against a checked-out repo. The system enumerates every tracked file (post-blacklist), runs the two-stage pipeline on each, and reports outcomes to the configured reporter. |
| W2  | `scan-changes`          | Stages selected files with `git add`, then invokes the CLI. The system scans only the staged set, otherwise behaving identically to `scan-all`.                                          |
| W3  | `resume`                | A previous run was interrupted. The user invokes `resume <run-id>`. The system restarts only the unfinished targets and reconciles partial reporter state against the VCS.                |
| W4  | Slash command on the web | Inside a Claude Code on the web sandbox session, the user types `/lbvd <subcommand> <args>`. The same engine runs; the run continues after the user closes the browser.            |
| W5  | DIY-cloud               | The user runs the CLI on a self-managed VM. Behavior is identical to W1/W2; recommended for runs that exceed the web sandbox preflight limits or for sensitive workloads.                |

## 5. Functional requirements

Each FR is at requirement level: a description, the key behaviors that must hold, and acceptance criteria written so a reviewer can verify them on a fixture repo. Implementation specifics (commands, schemas, file paths) live in `implementation.md`.

### FR-1 — File discovery
- **Description.** Produce the list of target files based on the selected scan mode.
- **Behaviors.**
  - `scan-all` returns every tracked file in the repo, minus all blacklist layers (FR-2).
  - `scan-changes` returns the staged file set (added, copied, modified, renamed) passed through the same blacklist filter. An empty staged index produces an empty target list and the run exits cleanly.
  - Discovery is deterministic for the same git tree state.
- **Acceptance.** The two modes produce the expected lists on a fixture repo; identical inputs produce identical lists.

### FR-2 — Blacklist filtering
- **Description.** Skip uninteresting files in three additive layers, in order: the project's `.gitignore`, a built-in noise list of well-known non-code paths, and a user-supplied pattern list in the configuration file.
- **Built-in noise categories.** Lockfiles, vendored dependencies, build outputs, minified assets, binary/image files, generated code, oversized files. Categories are *named groups* so users can opt out of specific built-in groups in config.
- **Behaviors.**
  - User patterns are additive on top of the defaults and use gitignore syntax.
  - A file matched by any layer is excluded; the run logs which layer matched (for debugging).
  - Users can disable a built-in category by name without disabling the whole built-in list.
- **Acceptance.** A fixture exercising all three layers produces the documented exclusion set and per-file layer-match logs.

### FR-3 — Concurrent two-stage pipeline
- **Description.** The system runs the stage-1 + stage-2 pipeline per target file, with at most `concurrency` pipelines simultaneously.
- **Behaviors.**
  - Each pipeline runs in isolation; no two pipelines share an output path.
  - An agent crash releases the pipeline's slot; the failed file is recorded in the manifest with its error, not retried automatically (but eligible for FR-12 resume).
  - Live concurrency is observable at runtime so verification can assert the cap is honored.
- **Acceptance.** With `concurrency=4` and 100 target files, no more than 4 agent sessions are alive at any sampled instant. An agent crash advances the rest of the run normally.

### FR-4 — Stage 1: vulnerability finder
- **Description.** For one target file, stage 1 invokes a finder agent and captures a structured finding.
- **Scan scope policy** — configurable per run, default = "hint + verify":
  - `hint_only`: agent reads only the hinted file.
  - `hint+verify` (default): agent may follow imports/usages once it has a candidate.
  - `repo_wide`: agent has unrestricted read access.
- **Output requirement.** Stage 1 always produces a structured finding. The finding either describes a vulnerability (with severity self-rated by the agent) or honestly states "no vulnerability found" with a short reason. **Absence of any output is treated as stage 1 having failed** (crashed, timed out, malformed) — no issue, no branch.
- **Network restriction.** Stage 1 has no internet access; only file-read tools.
- **Acceptance.**
  - On a fixture file with a known SQL-injection bug, stage 1 produces a finding mentioning injection.
  - On a clean fixture file, stage 1 produces a "no finding" record with a non-empty reason; stage 2 is skipped.
  - If stage 1 produces no output (or malformed output), the pipeline is recorded as failed; no issue, no branch.

### FR-5 — Stage 2: exploit generator
- **Description.** Given a stage-1 finding, stage 2 attempts to produce executable evidence in a strict order:
  1. Construct a runnable exploit script that demonstrates the vulnerability when executed.
  2. If 1 fails within a configured number of attempts, construct a unit test in the project's test framework that asserts on the unwanted behavior, or a proof-of-concept that demonstrates the vulnerability in isolation.
  3. If 2 also fails, mark the finding theoretical.
- **Sandbox capabilities.** Stage 2 has full sandbox access: network egress, package installation, shell, ability to spin up local services. Stage 2 has *no* outbound write capability — branch pushes and issue creation are owned by the reporter (FR-7).
- **Stateful infrastructure.** When exploitation requires a running service the project does not ship a way to start (database, message broker, etc.), stage 2 attempts setup within its wall-clock budget. If setup fails, stage 2 records what was needed (`infra_requirements`) and downgrades; the reporter then files a separate infra-tracking issue (FR-7).
- **Confidence semantics (tier-bound).** Each outcome carries a confidence score (integer 0–100) describing how likely the finding represents real undesired behavior:
  - Tier 1 (working exploit) → confidence = 100, fixed by the engine.
  - Tier 2 (unit test or PoC) → confidence is agent-assessed and clamped to `[0, 100]`.
  - Tier 3 (theoretical) → confidence = 0, fixed by the engine.
  Confidence is distinct from stage-1's `severity_self_rated`, which measures *impact if real*, not *likelihood*.
- **Wall-clock cap.** Stage 2 per finding is capped (default 10 minutes); exceeding the cap downgrades the outcome to tier 3.
- **Acceptance.**
  - On a fixture with a real, exploitable bug, stage 2 produces tier 1 with confidence = 100 (engine-fixed).
  - On a fixture where stage 2 falls back to tier 2, the agent's confidence is preserved, clamped to `[0, 100]`.
  - On a fixture where stage 2 falls back to tier 3, confidence = 0 (engine-fixed).
  - On a fixture requiring unobtainable preconditions, stage 2 records `infra_requirements`, downgrades, and the reporter files an infra-tracking issue.
  - Exceeding the wall-clock cap deterministically yields tier 3.

### FR-6 — Outcome routing & priority
- **Description.** Map each (tier, agent's stage-1 severity self-rating) pair to (branch?, issue priority).
- **Base tier mapping.**
  - Tier 1 → branch + issue, priority `high`. Tier 1 is *always* `high` regardless of the agent's severity rating.
  - Tier 2 → branch + issue, priority `medium`.
  - Tier 3 → issue only, priority `low`.
- **Severity bump (tier 2 / tier 3 only).** The agent's `severity_self_rated` may elevate the priority label *upward only* for tier 2 and tier 3:
  - tier 2 + self-rated `high` → priority `high` (tier 2 already has a branch, so no extra branch).
  - tier 3 + self-rated `high` → priority `medium` (still no branch — lack of evidence keeps it issue-only).
  - tier 3 + self-rated `medium` → priority `medium`.
  - All bumps are recorded in the issue body with the reasoning ("base medium → high because severity_self_rated=high").
- **Branch-or-not is gated by tier (evidence), not by the bump rule.**
- **Acceptance.** A run with synthetic findings exercising each (tier, severity) combination produces exactly the expected artifacts and a bump-recorded issue body where applicable.

### FR-7 — Reporter integration
- **Description.** A reporter abstraction routes finding outputs to the user's chosen destination. Three implementations ship in v1:
  - GitHub reporter.
  - GitLab reporter.
  - Local-only reporter (no network; writes the same content as markdown files under the run directory; selected via `output.mode: local`).
- **Per-finding artifact set.**
  - Tier 1 & 2: a single-commit branch containing the stage-1 narrative, the runnable artifact (exploit script, unit test, or PoC), and a how-to-reproduce note; plus a finding issue with the priority label.
  - Tier 3: a finding issue only; no branch.
- **Issue body fields** (in order): priority + tier reason; stage-1 self-rated severity; stage-2 confidence (0–100); priority bump applied (or `none`); file path + line range; branch URL (or `file://` URL in local mode); run-id; optional "previously reported (closed)" link (post-MVP, requires fingerprint lookup); vulnerability narrative; reproduction instructions; optional "also affects" list (post-MVP, requires within-run dedup); a hidden marker used by cross-run dedup (architectural; lookup deferred).
- **Sensitive-repo mode.** When configured (`vcs.exploit_target_repo`), branches and findings issues are pushed to a separate (typically private) repo; the source repo receives only a link-only tracking issue. A separate token env var may be configured for the target repo.
- **Local mode precedence.** When `output.mode: local`, all VCS configuration is ignored with a single startup warning and no outbound network calls are made.
- **Infra-needed tracking issue.** When stage 2 records `infra_requirements`, the reporter files a *third class of issue* (alongside regular findings and link-only tracking issues) that describes what infrastructure is needed and the runner environment, so the operator can pre-stage the dependency.
- **Security note (default behavior).** Branches contain runnable exploits for the source code. With the default reporter mode (push to source repo), anyone with read access to the source repo can read working exploits. Operators on shared/public repos should set `exploit_target_repo` to a private repo or use local mode. The default suits the initial private-repo deployments; the README runbook surfaces this prominently.
- **Acceptance.**
  - All three reporters honor the FR-6 outcome mapping.
  - With a target repo configured, branches and findings issues land there; the source repo gets a link-only tracking issue.
  - With a separate target token configured, both repos are written using their respective tokens; failed write checks at startup abort the run before stage 1 spends any tokens.
  - With local mode, no GitHub/GitLab calls are made; the local report dir contains every issue and branch artifact.
  - Branch push uses HTTPS auth via env tokens; no SSH keys.

### FR-8 — Deduplication (architectural; implementation deferred from MVP)
- **Description.** The system *architecturally* describes within-run and across-run dedup based on stable per-finding fingerprints, but the implementation is deferred from the MVP cut (see roadmap §9). The shape preserved here is the post-MVP target.
- **Within-run.** Group findings by fingerprint. Only the first finding in a group proceeds to stage 2; the rest are recorded as duplicates in the manifest and listed under "also affects" in the eventual issue body.
- **Across-run.** Before opening any issue, query the findings repo for an existing match:
  - Open match → skip; manifest records `skipped_existing`.
  - Closed match → file a new issue with a "previously reported (closed)" link to the original; manifest records `linked_to_closed`. (Reopen-and-comment is post-MVP backlog.)
- **Namespace separation.** Finding issues and infra-tracking issues live in *distinct* fingerprint namespaces and never cross-match.
- **Cross-mode coverage.** `scan-changes` and `scan-all` share the same dedup index.
- **Dedup query target.** Always queries the findings repo (target repo if configured, else source repo); the link-only tracking issue in the source repo is never dedup-matched.
- **Acceptance** (when implementation is brought online post-MVP):
  - Two back-to-back identical runs produce 0 new artifacts; manifest reports `skipped_existing`.
  - A finding hit in N files produces 1 branch and 1 issue listing all N files.
  - A reopened closure produces a new issue linking the original; the closed issue is unchanged.
  - After pre-staging an infra dependency, the next run's real finding is *not* suppressed by a still-open infra issue (namespace separation works).

### FR-9 — Configuration
- **Description.** A YAML configuration file at the repo root governs run behavior. CLI flags override the file; env vars override the file but not flags.
- **Configurable surfaces.** Concurrency, scan mode, scan scope, blacklist patterns and disable-builtins, wall-clock budgets, VCS provider/repo/branch, sensitive-repo target + token, output mode (vcs vs. local), web-sandbox preflight thresholds, agent authentication mode (FR-15).
- **Acceptance.**
  - Loading a config with unknown keys produces a clear error.
  - CLI flags win over the file (e.g., `--concurrency 1` runs serially regardless of file value).
  - Hitting the run-level wall-clock budget kills in-flight agents, flushes partial state, and records a clear termination outcome in the manifest.

### FR-10 — CLI surface
- **Subcommands.**
  - `lbvd scan-all [flags]`
  - `lbvd scan-changes [flags]`
  - `lbvd resume <run-id>`
  - `lbvd report <run-id>` — print the manifest as a table.
- **Common flags.** `--concurrency`, `--scope`, `--config`, `--dry-run`, `--auth-mode` (FR-15 mode override; values: `api_key`, `subscription`).
- **`--dry-run`** prints the resolved target list and exits without invoking agents.
- **Acceptance.** `--help` lists all subcommands; `scan-changes --dry-run` on a repo with no staged files exits cleanly with `0 targets`.

### FR-11 — Slash command for Claude Code on the web
- **Description.** A slash-command file makes the engine invokable inside a web sandbox session.
- **Bootstrap.** v1 runs from the local repo checkout (no published npm package); the slash-command body invokes the local CLI after a one-time `npm install` preflight if dependencies are missing. (Future migration to a published package only changes the slash-command body.)
- **Token preflight.** The slash command checks that the appropriate VCS token *and* the appropriate agent-auth token (per the configured FR-15 mode) are exported in the sandbox before invoking the engine. Under W4, the agent-auth mode is `subscription` and the preflight checks `CLAUDE_CODE_OAUTH_TOKEN`. The slash-command preflight is best-effort UX; the engine's substrate gate (architecture §20.4) is the authoritative check for `auth.mode` vs. substrate, and a run that passes preflight but violates the substrate constraint still aborts at engine startup.
- **Acceptance.** `/lbvd <subcommand> <args>` from the sandbox produces the same behavior as the equivalent CLI invocation.
- **Caveat.** Concurrency in the web sandbox is bounded by sandbox CPU/memory; the slash command's help text recommends DIY-cloud above 4 concurrency or for runs over 2 hours.

### FR-12 — Resumability
- **Description.** Every run records enough state to resume after interruption. Resume re-queues only the unfinished targets, restarts in-progress stages from the start of the stage, and reconciles any partial reporter work against the VCS so no orphan or duplicate artifacts result.
- **Per-target terminal states.** `done`, `failed`, `no_finding`, `skipped_dup`. (Detailed state machine in `architecture.md` §5 and `implementation.md` §3.4.)
- **Acceptance.**
  - Killing the engine mid-run and re-invoking `resume` finishes the remaining work without re-doing finished targets; the final manifest matches a single-uninterrupted-run baseline.
  - Killing the dispatcher between branch push and issue creation, then resuming, results in *exactly one* branch and *exactly one* issue per finding.
  - A `no_finding` outcome survives a crash-and-resume as `no_finding` and is not re-run.

### FR-13 — Manifest
- **Description.** Every run produces a machine-readable manifest plus a human-readable rendering, both written under the run directory.
- **Contents.**
  - Run config snapshot, total files scanned.
  - Counts by tier and by stage-1 severity self-rating crossed against tier.
  - Counts and lists by per-target outcome (with URLs / local paths where applicable).
  - Token usage statistics (per stage and overall): per-file counts, aggregates (min / median / mean / p90 / p95 / max), bucketed histogram. Token caps are not enforced; the histogram is the v1 substitute.
  - Stage-2 confidence histogram (bucketed integer 0–100; tier 1 contributes only to bucket 100, tier 3 only to bucket 0).
  - Stage-1 self-rated severity distribution (separate from the severity-vs-tier crosstab) — surfaces pathological "everything is high" runs that would inflate priority labels through the bump rule.
  - Wall-clock totals and any budget terminations.
  - Per-file errors with exception summaries.
- **Acceptance.** The CLI's `report` subcommand prints the markdown manifest. The JSON manifest validates against its documented schema. Token statistics are present even when no caps were hit.

### FR-14 — Substrates
- **Web sandbox (default route).** Single sandbox session hosts the engine; the run continues after the user closes the browser per the sandbox's lifetime guarantees.
- **DIY-cloud (alternate route).** Same CLI on a user-managed VM; behavior is identical. Recommended for runs that exceed sandbox limits or for sensitive workloads.
- **Web-sandbox preflight (fail-fast on oversized repos).** Before dispatch, the engine measures the *post-blacklist* target list on two axes — file count and total byte-size — and exits immediately with a clear "use DIY-cloud" recommendation if either threshold is exceeded. No automatic sharding in v1. Thresholds are configurable.
- **Acceptance.**
  - A scan over a small fixture repo completes successfully on both substrates and produces equivalent manifests.
  - A target list exceeding the file-count threshold triggers the preflight exit with a non-zero code; no agents are spawned.

### FR-17 — Application startup probe and serialized live verification

- **Description.** Before the per-target pipeline loop begins, the dispatcher runs a one-time *application startup probe* that analyses the target repository to determine how the application under test can be started and verifies that claim by actually starting it. The probe result is passed as context to all Stage 2 agents, enabling informed Tier 1 exploit attempts. When the probe cannot determine or confirm startup, Tier 1 verification is declared unavailable for the run and all Stage 2 Tier 1 claims are downgraded. To prevent race conditions between concurrent Stage 2 agents exercising the live application, the dispatcher enforces a single-holder mutex so at most one agent exercises the running application at any time.
- **Behaviors.**
  - The probe runs once per run, after discovery, before any per-target Stage 1 pipeline begins. It is not a per-target step.
  - The probe agent has the same capability set as Stage 2 (full shell, network egress, full-repo read), scoped to write only within its own subtree of the run directory (`<runDir>/probe/`).
  - The probe inspects the repository for startup artefacts — package.json scripts, Makefile targets, docker-compose files, CI configuration, README startup instructions — and selects the most appropriate start and stop commands.
  - The probe attempts to start the application and verifies it is reachable (TCP port listening and/or HTTP health-check response) within a configurable startup timeout.
  - The probe stops the application after the verification attempt. The application is not left running after the probe completes.
  - The probe agent writes its findings to `<runDir>/probe/app-probe.json`. After the probe agent exits and the dispatcher validates that file, the dispatcher writes the canonical `app-probe.json` to the dispatcher zone (the run directory root). Only the dispatcher writes to the dispatcher zone; the probe agent writes only to its own subtree. The canonical `app-probe.json` is immutable once written.
  - The probe has its own wall-clock budget (default 5 minutes, configurable). Exceeding the budget terminates the probe agent; the synthesized result has `startable: false, failure_reason: "probe_wall_clock_cap"`.
  - When `startable: true`, all Stage 2 agents receive the probe result (start commands, stop commands, port, health-check URL, startup timeout) as part of their invocation context so they can start the application themselves for Tier 1 verification. The dispatcher schema-validates the `start_commands` and `stop_commands` arrays (must be non-empty string arrays) before passing them to Stage 2 agents, to prevent a jailbroken probe from injecting arbitrary shell commands.
  - When `startable: false` (probe could not find startup instructions, startup attempt failed, or budget exceeded), Stage 2 agents receive this outcome. The dispatcher enforces a hard downgrade: any Tier 1 claim in a Stage 2 outcome is automatically downgraded to Tier 2, because live-application verification is known to be unavailable for this run.
  - Tier 1 exploitation requires exclusive access to the running application. At most one Stage 2 agent exercises the live application at any point. This is implemented as a filesystem-based mutex (`app-access.lock` in the run directory). A Stage 2 agent-host wanting live verification must acquire the mutex before starting the application, start the application, run the exploit, stop the application, and release the mutex in that order. The mutex acquisition uses a configurable timeout (default 120 seconds). An agent-host that cannot acquire the mutex within that timeout abandons live verification; the Stage 2 agent is informed via a tool response and the prompt instructs the agent to fall back to Tier 2 evidence. The existing budget-kill mechanism is unchanged: if the Stage 2 wall-clock budget expires (whether while waiting for the mutex or running the exploit), the dispatcher synthesizes a Tier 3 outcome per the standard wall-clock-cap rule (FR-5).
  - Each Stage 2 agent that holds the mutex starts the application fresh and stops it before releasing the mutex. If the application fails to start despite holding the mutex (command non-zero exit, port not reachable within startup timeout), the agent-host treats this the same as a mutex-acquisition failure — the agent is informed and the prompt instructs it to fall back to Tier 2. If the stop commands fail, the agent-host makes a best-effort attempt to kill the process by PID before releasing the mutex; the stop failure is logged but does not block mutex release.
  - The application process is started in a new process group so that the dispatcher's `runner.abort()` can signal the process group, preventing orphaned application processes when the Stage 2 agent is killed.
  - The probe result (startable, narrative, wall-clock seconds) appears in the manifest. When the probe was interrupted before completion (e.g., the run was budget-killed or signal-interrupted before the probe finished), the manifest records `app_probe: null`.
  - The probe creates its own subtree (`<runDir>/probe/`) in the run directory for its transcript and logs, following the same per-agent transcript discipline as per-target pipelines (NFR-3). The probe's PID is recorded in the dispatcher's in-flight spawn set so signal-shutdown propagates to the probe agent.
- **Resume.** The probe state is written atomically (write-temp-then-rename) before transitioning, so there is no partial-state window. If the probe was in-progress when the dispatcher crashed (probe state `running`), the probe re-runs from scratch on resume (agents are not internally resumable, per FR-12). If the probe completed (probe state `done`), the result is reused without re-probing, following the terminal-is-sticky invariant. On every dispatcher startup (including resume), a stale `app-access.lock` file whose recorded PID is no longer running is removed before pipelines begin.
- **Out-of-scope.**
  - Automatic setup of external services the application depends on (databases, message brokers). These remain under the existing `infra_requirements` path (FR-5).
  - Multiple simultaneous running instances of the application (single-instance model only).
  - Persistent application state across exploit verification attempts.
  - Application probe against a pre-deployed remote environment (probe targets only the local checkout).
- **Acceptance.**
  - A fixture repo with a startable application (e.g., `node server.js`) produces `app-probe.json` with `startable: true` and `start_commands`, `stop_commands`, `port` populated; Stage 2 receives this context.
  - A fixture repo with no discernible startup method produces `app-probe.json` with `startable: false`; the run continues; all Tier 1 claims in Stage 2 outcomes are downgraded to Tier 2 by the dispatcher.
  - Two concurrent Stage 2 agents competing for the app verification mutex: the second acquires the mutex only after the first releases it; no execution record shows a port conflict.
  - A probe that exceeds its wall-clock budget produces `startable: false` with `failure_reason: "probe_wall_clock_cap"`; the run continues normally.
  - On resume when the probe state was `running`: the probe re-runs. On resume when the probe state was `done`: the probe result is reused without re-running the probe.
  - The manifest includes an `app_probe` field with `startable`, a narrative summary, and wall-clock seconds.

### FR-15 — Agent authentication mode
- **Description.** The operator selects the credential the agent runner uses to reach Anthropic. v1 supports two modes:
  - **`api_key`** — Anthropic Console API key, read from `ANTHROPIC_API_KEY`. Pay-per-token billing.
  - **`subscription`** — long-lived OAuth token from `claude setup-token`, read from `CLAUDE_CODE_OAUTH_TOKEN`. Consumes the operator's Claude.ai subscription quota (Pro / Max / Team / Enterprise plan required).
- **Selection.** The mode is configured (`auth.mode`); default = `api_key`. CLI/env override per FR-9 precedence.
- **Behaviors.**
  - Startup validates the env var named by the configured mode is present and non-empty. A missing or blank token aborts the run before any agent is spawned (parallel to the FR-7 forge-write preflight).
  - The agent subprocess receives *only* the credential for the selected mode. The other auth env vars (e.g., `ANTHROPIC_API_KEY` when mode is `subscription`) are dropped from the subprocess environment so Claude Code's internal auth-precedence chain cannot pick the unintended credential.
  - The selected token is subject to NFR-2 redaction in all logs and on-disk transcripts.
  - The web sandbox (W4) is restricted to `subscription` mode — Claude Code on the web ignores `ANTHROPIC_API_KEY` in the sandbox and always uses subscription credentials. Selecting `api_key` while running under W4 aborts at startup with a clear message.
- **Out-of-scope (operator concerns, not engine-enforced).**
  - Plan-tier verification — the engine does not query the operator's plan; an attempted run on a plan that does not support OAuth tokens fails with whatever error the SDK returns. The README runbook documents the plan requirement.
  - Multi-tenant / redistribution use — Anthropic restricts subscription OAuth tokens "in any product, tool, or service." LLM-based Vulnerability Detector acting on the operator's own repositories (single-tenant) is inside the documented fair-use carve-out; redistribution is out of scope for v1 and the README calls this out.
  - Host-environment hygiene — a host with a configured `apiKeyHelper` can inject credentials the runner-env chokepoint cannot see (per Claude Code's auth precedence; see architecture §20.2). The README runbook calls this out as an operator-environment hazard.
- **README runbook expectations.** The README must document, in the same change that lands FR-15 in code: (a) the two modes and how to generate each credential (`claude setup-token` for `subscription`); (b) the plan-tier requirement; (c) the redistribution / single-tenant ToS posture; (d) the recommendation to set `auth.mode: subscription` for repos primarily run from the web sandbox; (e) the `apiKeyHelper` host hazard.
- **Acceptance.**
  - With `auth.mode: api_key` and `ANTHROPIC_API_KEY` set, a fixture run produces the same manifest shape as the equivalent `auth.mode: subscription` run with `CLAUDE_CODE_OAUTH_TOKEN` set.
  - With the configured mode's env var unset or blank, the run aborts at startup with a non-zero exit and a clear "missing credential" message naming the env var and the corrective action (`claude setup-token` for subscription, "export ANTHROPIC_API_KEY" for api_key); no agent subprocess is spawned. The error message never embeds the token value.
  - Setting both env vars while `auth.mode: subscription` is configured behaves identically to setting only `CLAUDE_CODE_OAUTH_TOKEN` — the API key is dropped from the subprocess environment and is not the active credential.
  - **Direct env-isolation observation.** When `auth.mode: subscription` is configured and both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are set on the dispatcher, an inspection of the spawned agent subprocess's environment shows `ANTHROPIC_API_KEY` absent and `CLAUDE_CODE_OAUTH_TOKEN` present. The symmetric assertion holds for `auth.mode: api_key`. Empty-string and unset are treated identically.
  - **Direct redaction observation.** The selected token's literal value, when it appears in an agent's transcript stream (e.g., echoed by a tool), does not appear cleartext in `stage{1,2}.transcript` on disk. The same property holds for both modes.
  - The OAuth token does not appear in any log line, manifest, or transcript on disk (NFR-2 inheritance).
  - On W4 (web sandbox), `auth.mode: api_key` aborts at startup with a substrate-specific message recommending `subscription` mode.
  - **Resume mode-mismatch.** Resuming a run that began under `auth.mode: subscription` while the current config has `auth.mode: api_key` aborts with a clear "auth-mode mismatch" error; no agent subprocess is spawned. Token-value rotation under the *same* mode (e.g., a new `CLAUDE_CODE_OAUTH_TOKEN` value between original and resume) is accepted.
  - **Fixture-runner carve-out.** When `runner.kind: fixture` (or `LBVD_RUNNER=fixture`) is active, credential validation is skipped — the fixture runner does not authenticate to Anthropic and has no credential to mask. This makes test fixtures runnable without a real Anthropic token. The dispatcher emits its existing fixture-runner INFO warning so operators see the indicator. See architecture §20.3.

### FR-16 — Graceful shutdown and intermediate manifest

- **Description.** When the dispatcher process receives SIGINT (Ctrl+C) or SIGTERM (kill from the OS or container orchestrator), it performs a controlled shutdown: no new pipelines start, in-flight agents are stopped, the current partial state is persisted, and both manifest files are written reflecting what completed, what was interrupted, and what had not yet started.

- **Behaviors.**
  1. SIGINT and SIGTERM both trigger the shutdown sequence identically.
  2. Signal handlers are one-shot: a `killed` flag is checked as the first action; a second signal invokes the handler again but returns immediately. Listeners are removed only after the graceful drain completes (in the `finally` block around `Promise.all`). This avoids Node.js re-applying the default exit-130 behavior, which occurs when listeners are removed *inside* the handler before the drain finishes.
  3. In-flight agents are stopped using the same abort mechanism as the run-budget kill: SIGTERM to the agent subprocess, then SIGKILL after the 10 s grace period if still running.
  4. `state.terminations[]` receives a new entry with `kind = "user_interrupt"`, the signal name, the interrupt time, and a human-readable reason.
  5. After all in-flight agents have exited: `state.ended_at` is set, `state.json` is persisted atomically, and `manifest.json` + `manifest.md` are written.
  6. The process exits with code 6 (distinct from budget-kill code 4 and normal-completion code 0).
  7. Targets in terminal states at interrupt time (`done`, `failed`, `no_finding`) appear in the manifest with their complete outcomes and VCS URLs.
  8. Targets still queued at interrupt time appear in the manifest with `state = "queued"` and null tier/severity/confidence fields.
  9. Targets whose pipeline was in progress at interrupt time appear with their last persisted non-terminal state; they are eligible for `resume` (FR-12).
  10. `manifest.md` renders the `user_interrupt` termination entry in its Terminations section, including the signal name.

- **Out-of-scope.**
  - Mid-stage checkpointing: an interrupted stage-1 or stage-2 agent restarts from scratch on the next `resume`; there is no within-agent checkpoint.
  - Automatic re-queueing of in-progress targets: `resume` handles that.
  - Signals other than SIGINT and SIGTERM.

- **Acceptance.**
  1. Running a fixture scan and delivering SIGINT to the dispatcher produces both `manifest.json` and `manifest.md` in the run directory within 15 s of signal delivery.
  2. `manifest.json` contains a `terminations` entry with `kind = "user_interrupt"` and the signal name.
  3. Targets completed before the signal appear in the manifest with their terminal state and any artifact URLs.
  4. Targets queued at signal time appear in the manifest's `outcomes` list with `state = "queued"` and null numeric fields.
  5. The process exits with code 6.
  6. Delivering a second SIGINT while shutdown is in progress terminates the process immediately (within 1 s) without triggering a second manifest write. A double-signal forced exit produces no manifest or a partial one; this is acceptable and documented behavior — `resume` can reconstruct the run from `state.json`.
  7. Running `resume <run-id>` after an interrupted run re-queues only the non-terminal targets and produces a final manifest matching what an uninterrupted run would produce (FR-12 acceptance extended to signal-interrupted runs).

## 6. Non-functional requirements

- **NFR-1 — Determinism of artifact paths.** Given the same run identifier, all per-run artifact paths are reproducible.
- **NFR-2 — Secret hygiene.** All tokens (VCS tokens, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, any token named in `vcs.exploit_target_token_env`) are read from env at startup, redacted in all logs and on-disk transcripts, and never written to disk in cleartext.
- **NFR-3 — Audit trail.** Every agent session's full transcript is saved to disk for post-hoc review (after the redaction required by NFR-2).
- **NFR-4 — Idempotent issue creation** *(architectural; tied to FR-8 dedup, deferred from MVP)*. Re-running with the same fingerprints produces zero new issues.
- **NFR-5 — Cost observability.** v1 enforces hard *time* caps but does *not* cap per-agent token usage; the manifest's token statistics are the substitute. The schema reserves cap names for later re-introduction.
- **NFR-6 — Failure isolation.** A crash in one pipeline does not corrupt sibling pipelines or the run state. Atomic state writes; per-pipeline exception boundaries.
- **NFR-7 — Logging.** Structured JSON logs to stdout at INFO; DEBUG to a file. Each line carries `run_id`, `agent_id`, `target_file` where applicable.

## 7. Verification plan

End-to-end smoke test on a fixture repo before sign-off:

1. The CLI's `--help` succeeds.
2. The fixture repo has three planted files: a clean file, an exploitable `eval()` file, and a real-but-hard-to-exploit timing leak.
3. `scan-all` against a test VCS repo with appropriate tokens produces:
   - 1 tier-1 issue + branch with a runnable exploit (executing the exploit script demonstrates the bug).
   - 1 tier-2 or tier-3 issue depending on the timing-leak file's outcome.
   - 1 tier-3 (or `no_finding`) record for the clean file.
4. *(Post-MVP — requires FR-8 dedup.)* Re-running produces 0 new issues / branches; manifest reports `skipped_existing` for each.
5. `scan-changes` after staging a single file scans only that file.
6. **Resumability.** Killing the dispatcher mid-run with SIGTERM and re-invoking `resume` finishes the remaining work; the final manifest matches the baseline.
7. **Slash-command path.** From a Claude Code on the web session, the same command produces equivalent manifests up to run-id and timestamps.
8. **Application startup probe (FR-17).** A fixture repo that includes a startable server script produces `app-probe.json` with `startable: true`; Stage 2 receives the probe context; the manifest includes `app_probe.startable = true`.
9. **No-probe fallback (FR-17).** A fixture repo with no startup artefacts produces `app-probe.json` with `startable: false`; all Tier 1 claims in that run's Stage 2 outcomes are downgraded to Tier 2.
10. **Mutex serialization (FR-17).** With concurrency ≥ 2 and two fixture Stage 2 agents both requesting live verification, their execution records do not overlap in time; no port-conflict errors appear.

Unit-level tests cover discovery, blacklist layering, fingerprinting stability (when implemented), and the dedup query (when implemented).

## 8. Feature → requirement mapping

| Feature                              | Requirements         | Workflows           |
|--------------------------------------|----------------------|---------------------|
| File discovery                       | FR-1                 | W1, W2              |
| Blacklist filtering                  | FR-2                 | W1, W2              |
| Concurrent two-stage pipeline        | FR-3                 | W1, W2, W3          |
| Vulnerability finder agent           | FR-4                 | W1, W2              |
| Exploit generator agent              | FR-5                 | W1, W2              |
| Outcome tier + priority routing      | FR-6                 | W1, W2              |
| GitHub reporter                      | FR-7                 | W1, W2              |
| GitLab reporter                      | FR-7                 | W1, W2              |
| Local-only reporter                  | FR-7                 | W1, W2              |
| Sensitive-repo mode                  | FR-7                 | W1, W2              |
| Infra-needed tracking issue          | FR-5, FR-7           | W1, W2              |
| Deduplication *(post-MVP)*           | FR-8, NFR-4          | W1, W2, W3          |
| Configuration                        | FR-9                 | (all)               |
| CLI subcommands                      | FR-10                | W1, W2, W3, W5      |
| Slash command                        | FR-11                | W4                  |
| Resume                               | FR-12                | W3                  |
| Manifest                             | FR-13                | (all)               |
| Web-sandbox preflight                | FR-14                | W4                  |
| DIY-cloud runbook                    | FR-14                | W5                  |
| Token redaction (logs + transcripts) | NFR-2, NFR-3         | (all)               |
| Per-agent transcripts                | NFR-3                | (all)               |
| Cost observability (token stats)     | NFR-5, FR-13         | (all)               |
| Agent auth mode (API key / subscription) | FR-15, FR-9, NFR-2 | (all)               |
| Graceful shutdown + intermediate manifest | FR-16, FR-12, FR-13 | (all)              |
| Application startup probe                | FR-17                | W1, W2, W3         |
| Serialized live exploit verification     | FR-17, FR-5          | W1, W2, W3         |

## 9. Roadmap

### Status (2026-05-09)

The MVP loop **discover → finder → exploiter → report** is implemented for
GitHub + Local reporters; the SDK runner is real (not a fixture-only stub).
Implementation status per phase is in `plans/implementation.md` §0 / §6.

### Post-MVP backlog

Shapes are preserved in the schemas / interfaces; only the call sites are
gated. Each item below is one-flag work to enable when prioritized.

- **Cross-run dedup at *initial open*** — finding-issue creation does not
  consult `findIssueByMarker` before opening; resume reconciliation already
  uses it for FR-12 idempotency. Flip the gate in
  `dispatcher/pipeline.ts:reportPhase` to enable.
- **Reopen-and-comment for closed issues** — refinement of
  `linked_to_closed`.
- **Cross-mode "Also affects" enrichment** — when a later run reveals
  additional affected files for an already-open issue.
- **Cross-file collision-rate analytics** — deferred until real-world runs
  show whether the metric is signal or noise.
- **Notifier (email / webhook / summary issue)** — `onTerminal` reporter
  hook is reserved with a no-op default.
- **GitLab reporter** — `selectReporter()` rejects `vcs.provider=gitlab`
  today; the interface reserves the seat.
- **GitHub HTTP-replay layer** — gated on operator setup of a long-lived
  test repo (provisioned via `scripts/setup-fixtures-repo.sh`).
