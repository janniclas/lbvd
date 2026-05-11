# LLM-based Vulnerability Detector — Implementation Plan

Concrete plan derived from `requirements.md` (the *what*) and `architecture.md`
(the *how*). Names file paths, library choices, function signatures, JSON-schema
shapes, and the build sequence. When this and `architecture.md` disagree, defer
to `architecture.md`.

## Status (2026-05-11)

MVP loop **discover → finder → exploiter → report** is implemented; the
HTTP-replay layer for the GitHub reporter has landed. `npx tsc --noEmit` is
clean; `npm run lint:boundaries` is OK across 55 files (now walks `scripts/`
in addition to `src/`).

**Phases done:** 0–9 (foundation through resume), 10 (HTTP-replay layer:
pluggable `Transport` interface, replay/recording transports, corpus
validation, recorder harness, offline synth fallback, contract tests for
branch-name / issue-body / Local↔GitHub-replay equivalence), 12
(sensitive-repo / dual-token), 13 (real Claude Agent SDK driver including
`canUseTool` capability gate), 14 (substrate detection / preflight), 15
(slash command), 16 (hardening). Plus follow-up additions: AJV-backed
schemas, stage-1 wall-clock cap (default 120 s), `config_files`
default-blacklist group, manifest stage1/stage2 wall-clock aggregation,
F5 (agent authentication mode — FR-15 / §20),
F6 (graceful shutdown + intermediate manifest — FR-16 / §21).

**Phase 10 corpus refresh path:** committed corpus under
`tests/fixtures/http/github/` is currently synth-derived (placeholder shas).
Refresh against the live API requires provisioning a dedicated fixtures
repo (see `scripts/setup-fixtures-repo.sh`) and a fine-grained PAT scoped
to it, then `npm run record-http:github`. Until refreshed, the equivalence test runs
against synthetic responses and the contract surface is the load-bearing
guarantee, not the byte-fidelity of the responses.

**Phases not done:**
- **Phase 11 (GitLab reporter)** — confirmed post-MVP per user decision.
  `selectReporter()` throws when `vcs.provider=gitlab`.

Open architectural / scope items live in `plans/open-questions.md`.

---

## 1. Stack & libraries

- **Runtime.** Node.js LTS (≥ 20.x).
- **Execution.** No compile step; `tsx` runs TypeScript directly per architecture §2.
- **Language.** TypeScript with `strict: true`, `noUncheckedIndexedAccess: true`,
  `exactOptionalPropertyTypes: true`. Loosening any of these is a regression.

One library per concern (architecture §2):

| Concern | Library | Note |
|---|---|---|
| YAML parsing | `yaml` | Strict mode; positional errors |
| JSON-schema validation | `ajv` + `ajv-formats` | Compile schemas at startup |
| Gitignore-style matching | `ignore` | Used per blacklist layer |
| Child-process orchestration | Node `node:child_process` | No wrapper |
| HTTPS clients | `undici` | One HTTP layer for both forges |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` | Architecture §2 |
| CLI parsing | `commander` | Stable exit-code handling |
| Test runner | `node:test` + `tsx` | No external runner |

Logging is hand-rolled (§5.2) — no `pino`/`winston`/`chalk`. The redaction discipline
(architecture §15.2) forbids importing log libraries that may bypass the chokepoint.
No `dotenv` (env is set by the substrate). No monorepo or workspace tooling.

---

## 2. Directory structure

```
.
├── README.md
├── CLAUDE.md
├── package.json
├── tsconfig.json
├── plans/                            ← requirements, architecture, this file, open-questions, agent-guide
├── scripts/
│   ├── lint-boundaries.ts            ← CI lint for §10 hard constraints
│   └── setup-fixtures-repo.sh        ← provisions Phase 10 fixtures repo
├── schemas/                          ← canonical JSON-Schema (AJV input)
│   ├── finding.schema.json
│   ├── outcome.schema.json
│   └── state.schema.json
├── src/
│   ├── cli.ts                        ← entry, subcommand dispatch
│   ├── dispatcher/
│   │   ├── index.ts, run.ts          ← entry orchestration
│   │   ├── loop.ts                   ← main loop, run-budget abort, slot pool
│   │   ├── pipeline.ts               ← per-target state-machine driver
│   │   ├── reconcile.ts              ← resume reconciliation + orphan sweep
│   │   ├── state.ts                  ← state.json reader/writer + AJV validator
│   │   ├── telemetry.ts              ← active.json reader/writer
│   │   └── slot.ts                   ← concurrency cap accounting
│   ├── runner/
│   │   ├── interface.ts              ← Runner type, Capability union
│   │   ├── select.ts                 ← env / config → runner
│   │   ├── sdk-runner.ts             ← spawn agent-host as subprocess
│   │   ├── agent-host.ts             ← in-subprocess Claude Agent SDK driver
│   │   ├── sdk-tool-shim.ts          ← canUseTool capability gate (load-bearing)
│   │   ├── safe-env.ts               ← env allowlist for agent subprocess
│   │   ├── fixture-runner.ts         ← canned-output runner for tests
│   │   └── fixture-host.ts           ← in-subprocess fixture driver
│   ├── stage1/
│   │   ├── invoke.ts                 ← spawn + budget timer + validate
│   │   ├── prompt.ts                 ← system prompt
│   │   └── schema.ts                 ← AJV-compiled finding validator
│   ├── stage2/
│   │   ├── invoke.ts                 ← spawn + budget timer + tier validate
│   │   ├── prompt.ts                 ← system prompt
│   │   ├── schema.ts                 ← AJV-compiled outcome validator
│   │   └── tier-validate.ts          ← tier-claim falsifiability check
│   ├── reporter/
│   │   ├── interface.ts, select.ts   ← Reporter type + factory
│   │   ├── github.ts                 ← REST via undici (HTTP-replay TBD)
│   │   ├── local.ts                  ← writes branches + issues to disk
│   │   ├── issue-body.ts             ← markdown + hidden HTML-comment marker
│   │   ├── branch-name.ts            ← deterministic naming
│   │   └── http.ts                   ← undici client + retry policy
│   ├── routing/route.ts              ← (tier,severity) → (branch?, priority, bump)
│   ├── identity/fingerprint.ts       ← SHA over (category + normalized snippet)[:12]
│   ├── redaction/                    ← patterns + redact() + redactStream()
│   ├── clock/clock.ts                ← Clock interface + system + deterministic
│   ├── config/                       ← YAML loader + override layering + AJV-ish schema
│   ├── discovery/                    ← enumerate, blacklist, dry-run
│   ├── manifest/                     ← build, render-md, write, report
│   ├── substrate/                    ← detect, preflight
│   ├── log/log.ts                    ← JSON-lines emitter (chokepoints redaction)
│   └── util/
│       ├── ajv.ts                    ← shared AJV compiler
│       ├── safe-path.ts              ← confineToParent (realpath + prefix-check)
│       └── safe-stderr.ts            ← redacted process.stderr.write
├── tests/
│   ├── workflow/                     ← end-to-end against fixtures (10 files)
│   ├── unit/                         ← contracts of pure modules (17 files)
│   └── fixtures/canned-agents/       ← finding.json/outcome.json corpora
└── slash-commands/lbvd.md      ← `/lbvd` slash command body
```

**Schema source of truth.** `schemas/*.schema.json` are canonical (AJV-compiled
at startup via `src/util/ajv.ts`); `src/*/schema.ts` reads them via `fs` and
exposes a typed validator. Three schemas exist today (`finding`, `outcome`,
`state`); `config.schema.json` is intentionally not yet written — `state.json`
schema documents `config_snapshot` as deliberately loose pending it. No
`schemas/manifest.schema.json` either; the manifest TS shape lives in
`src/manifest/build.ts`.

`.lbvd/` (per-run output tree, architecture §4.1) is in `.gitignore`.

---

## 3. Canonical schemas

Each shape below is the conceptual spec. Formal JSON-Schema documents live in
`schemas/*.schema.json` and are imported by their `src/*/schema.ts` companions
(compiled by `ajv` at startup). Every top-level document carries `schema_version: 1`.

**Bump policy** (architecture §12.4). Forward-compatible additions — new
optional keys, new enum values that have a sensible default — do not bump
`schema_version`. Removes, renames, type changes, and new required fields *do*
bump and require a `CHANGELOG.md` migration note plus a hand-authored migration
for existing on-disk artifacts. There is no automated migration tool until a
real bump happens.

### 3.1 Config (`schemas/config.schema.json`)

```yaml
schema_version: 1
concurrency: 4
scan:
  scope: hint+verify        # hint_only | hint+verify | repo_wide
budgets:
  stage2_per_finding_seconds: 600     # default 10 min (FR-5)
  run_seconds: 14400                  # default 4 h
blacklist:
  disabled_builtins: []     # subset of named built-in groups (§5.6)
  patterns: []              # gitignore syntax
vcs:
  provider: github          # github | gitlab
  repo: owner/name
  default_branch: main
  source_token_env: GITHUB_TOKEN
  exploit_target_repo: ""
  exploit_target_token_env: ""
output:
  mode: vcs                 # vcs | local
  local_dir: .lbvd/local-report
preflight:
  enabled_on_substrate: web-sandbox
  max_targets: 5000         # decision 8
  max_tree_bytes: 2147483648
runner:
  kind: sdk                 # sdk | fixture (env override: LBVD_RUNNER)
  sdk:
    model: claude-opus-4-7
auth:
  mode: api_key             # api_key | subscription (FR-15, architecture §20)
# reserved (NFR-5): tokens.* — accepted, inert.
```

Validation rules:
- Unknown keys at any level → fatal error with file:line:col.
- `output.mode = local` ⇒ all `vcs.*` accepted but inert; one warning at startup.
- `vcs.exploit_target_repo` non-empty ⇒ `vcs.exploit_target_token_env` must be set
  AND that env var must be present at startup (verified before any agent spawns,
  FR-7 / decision 14).
- `auth.mode = api_key` ⇒ `ANTHROPIC_API_KEY` must be present and non-empty.
  `auth.mode = subscription` ⇒ `CLAUDE_CODE_OAUTH_TOKEN` must be present and non-empty.
  Empty-string and unset are treated identically (both fail). The error message
  names the configured mode's env var and the corrective action; it never
  embeds the token value. Skipped on `--dry-run` and when the fixture runner
  is active (FR-15 acceptance, architecture §20.3).
- `concurrency ≥ 1`. `budgets.*` integers > 0.

### 3.2 `finding.json` (per-target, written by stage 1; architecture §7)

```ts
{
  schema_version: 1,
  fingerprint: string,                 // 12 hex chars; sealed in stage 1
  status: "vulnerability" | "no_finding",
  target_file: string,                 // relative to repo root
  category: string,                    // free-form; used in fingerprint input
  // present iff status = "vulnerability":
  severity_self_rated?: "low" | "medium" | "high",
  location?: { start_line: number, end_line: number },
  narrative?: string,                  // markdown
  // present iff status = "no_finding":
  no_finding_reason?: string,
  stage1_token_usage: { input: number, output: number }
}
```

`stage1/invoke.ts` validates against this schema; missing or malformed file ⇒
stage 1 recorded as `failed` (architecture §7.2). The fingerprint is sealed here
and never recomputed downstream (architecture §7.5).

### 3.3 `outcome.json` (per-target, written by stage 2; architecture §8)

```ts
{
  schema_version: 1,
  fingerprint: string,                 // copied from finding
  tier: 1 | 2 | 3,                      // dispatcher-validated value
  tier_claim: 1 | 2 | 3,                // agent's claim before validation
  confidence: number,                  // integer 0..100
  exploit_artifact_path: string | null,    // relative to per-target subtree
  test_artifact_path: string | null,
  execution_record:
    | { exit_code: number, captured_output: string, ran_at: string /* ISO */ }
    | null,
  infra_requirements: {
    needed: string[],                  // human-readable list
    attempted: string[],
    runner_environment: { os: string, arch: string }
  } | null,
  downgrade_reason: string | null,     // set when tier < tier_claim
  stage2_token_usage: { input: number, output: number },
  stage2_wall_seconds: number
}
```

`tier-validate.ts` rules:
- `tier_claim = 1` requires `exploit_artifact_path` AND
  `execution_record !== null` AND `execution_record.exit_code === 0`. Otherwise
  downgrade to `tier_claim - 1` with `downgrade_reason = "claim_unsubstantiated"`.
- `tier_claim = 2` requires `test_artifact_path` AND `execution_record !== null`
  AND test framework reports the asserted failure (`exit_code !== 0` for the
  unwanted-behavior assertion). Same downgrade shape.
- After validation, the engine fixes confidence: tier 1 → 100, tier 3 → 0
  (architecture §8.3).
- Wall-clock cap exceeded ⇒ `tier = 3`, `confidence = 0`,
  `downgrade_reason = "wall_clock_cap"` (architecture §8.6).

### 3.4 `state.json` (run state ledger; architecture §5)

```ts
{
  schema_version: 1,
  run_id: string,
  config_snapshot: ResolvedConfig,
  started_at: string,                  // ISO-8601
  ended_at: string | null,
  targets: {
    [relativeTargetPath: string]: {
      state:
        | "queued"
        | "stage1_running"
        | "stage2_running"
        | "stage2_done"
        | "reporting_branch"
        | "reporting_issue"
        | "reporting_infra"             // post-finding-issue, before infra issue lands
        | "reporting_tracking"          // post-finding-issue, before source-repo tracking issue lands
        | "done"
        | "failed"
        | "no_finding"
        | "skipped_dup",                // reserved; not produced in MVP (§11)
      fingerprint: string | null,
      branch_url: string | null,
      issue_url: string | null,
      infra_issue_url: string | null,
      tracking_issue_url: string | null,
      error: string | null,
      stage1_started_at: string | null,
      stage2_started_at: string | null,
      completed_at: string | null
    }
  },
  terminations: { kind: "run_budget" | "user_interrupt", at: string, reason: string, signal?: "SIGINT" | "SIGTERM" }[]
}
```

Architecture §5.2 invariants: forward-only transitions; terminal states
(`done`/`failed`/`no_finding`/`skipped_dup`) are sticky. Atomic writes via
write-temp-then-rename (architecture §5.1).

**F6 schema addition (architecture §21.6, decision 27):** `Termination.kind` extended to `"run_budget" | "user_interrupt"`. Optional `signal?: "SIGINT" | "SIGTERM"` field added (absent for `run_budget` entries; present for `user_interrupt`). Forward-compatible — existing records validate unchanged. Both `src/dispatcher/state.ts` (TypeScript type) and `schemas/state.schema.json` (JSON schema `kind` enum + `signal` property) must be updated in the same change.

The state-machine transition graph:

```
queued
  → stage1_running
       → no_finding              (terminal)
       → failed                  (terminal; bad/missing finding.json)
       → stage2_running
            → failed             (terminal; bad/missing outcome.json)
            → stage2_done
                 → reporting_branch    (tier 1 or 2 only)
                      → reporting_issue
                 → reporting_issue     (tier 3; skips branch step)
                      → reporting_infra      (iff outcome.infra_requirements)
                           → reporting_tracking  (iff vcs.exploit_target_repo)
                                → done   (terminal)
                           → done            (terminal; no tracking)
                      → reporting_tracking   (no infra; iff vcs.exploit_target_repo)
                           → done            (terminal)
                      → done                  (terminal; no infra, no tracking)
```

Each transition into a `reporting_*` state is paired with the persistence of the
corresponding URL field in the same target's record (architecture §5.4
idempotency requires URLs survive a crash mid-reporter-run). Algorithm in §5.10.

### 3.5 `active.json` (live agent telemetry; architecture §6)

```ts
{
  schema_version: 1,
  agents: {
    agent_id: string,                  // uuid
    target_file: string,
    stage: 1 | 2,
    started_at: string,
    pid: number
  }[]
}
```

Truncated at startup (architecture §6.2, §6.4). Single-writer (dispatcher only,
architecture §6.3). Atomic write-temp-then-rename. Observers may read at any
time; the file is meaningful only while the dispatcher process is alive.

### 3.6 `manifest.json` (architecture §16, FR-13)

Top-level fields:

- `schema_version`, `run_id`, `started_at`, `ended_at`, `total_files`, `concurrency`.
- `outcomes`: per-target list with `target_file`, `state`, `tier`, `severity_self_rated`, `confidence`, `priority`, `bump_reason`, `branch_url`, `issue_url`, `infra_issue_url`, `tracking_issue_url`, `error`.
- `counts_by_tier`: `{ tier1, tier2, tier3, no_finding, failed }`.
- `counts_by_outcome`: by per-target `state`.
- `severity_vs_tier_crosstab`: `{ [severity]: { tier1: n, tier2: n, tier3: n } }`.
- `severity_self_rated_distribution`: `{ low, medium, high }` over all findings.
- `confidence_histogram`: 101 buckets (0..100); tier 1 contributes only to
  bucket 100; tier 3 only to bucket 0.
- `token_usage`:
  - `per_stage`: `{ stage1: TokenStats, stage2: TokenStats }`
  - `overall`: `TokenStats`
  - `TokenStats`: `{ per_file: { target, input, output }[], aggregates: { min, median, mean, p90, p95, max }, histogram: { input: bucketed, output: bucketed } }`
- `wall_clock_totals`: `{ run_seconds, stage1_seconds, stage2_seconds }`.
- `terminations`: copied from `state.json`.
- `errors`: per-failed-target `{ target_file, error }`.

Architecture §16.2: derived from per-target subtrees on demand
(`buildManifest()` and `report` subcommand both call the same builder). No
running counters in the dispatcher.

---

## 4. Per-run filesystem layout

```
<repo>/.lbvd/<run-id>/
├── state.json                ← dispatcher zone
├── active.json               ← dispatcher zone
├── manifest.json             ← built at run end
├── manifest.md               ← rendered from manifest.json
├── config.snapshot.yaml      ← dispatcher zone
├── run.log                   ← INFO JSON-lines (dispatcher)
├── debug.log                 ← DEBUG (dispatcher)
├── targets/
│   ├── _pending/                                ← pre-fingerprint staging
│   │   └── <sha1(relpath)[:12]>/                ← agent writes here first
│   └── <fingerprint>/                           ← renamed once finding.json lands
│       ├── finding.json
│       ├── outcome.json
│       ├── exploit.<ext>     (optional)
│       ├── unit-test.<ext>   (optional)
│       ├── stage1.transcript
│       ├── stage2.transcript
│       ├── stage1.log
│       └── stage2.log
└── local-report/                                ← present iff output.mode = local
    ├── issues/<issue-id>.md
    ├── infra-issues/<issue-id>.md
    └── branches/<branch-name>/
        └── <files mirroring what the forge reporter would commit>
```

**Per-target directory naming.** The architecture (§4.6) requires the per-finding
identifier to name the per-target subtree. Stage 1 produces the fingerprint, so
the directory cannot be named at spawn time. Resolution: the dispatcher creates
`targets/_pending/<sha1(relpath)[:12]>/` for stage 1 to write into; once
`finding.json` lands and validates, the dispatcher renames the directory to
`targets/<fingerprint>/` atomically. Stage 2 spawns against the renamed path.
A pipeline that fails before fingerprint is sealed remains under `_pending/`.

**Run identifier format.** `YYYYMMDDTHHMMSSZ-<8-hex>` (UTC timestamp + random
suffix). Satisfies architecture §4.5: unique, path-safe on macOS/Linux/sandbox,
sortable by creation time, caller-injectable via `--run-id` flag.

---

## 5. Module specifications

Each module has one entry below. Function signatures here are normative for the
implementation; helper functions are at the implementer's discretion as long as
the public surface and the architectural invariants hold.

### 5.1 `clock` (architecture §3.5, §19.4)

```ts
export interface Clock {
  now(): Date;                           // wall time
  monotonicMs(): number;                 // ms since process start (or fake epoch)
}
export const systemClock: Clock;
export function deterministicClock(start: Date): Clock & { advance(ms: number): void };
```

CI lints reject `Date.now()`, `new Date()`, and `process.hrtime` outside
`src/clock/`. Production callers receive a `Clock` via parameter; tests inject
`deterministicClock`.

### 5.2 `log` + `redaction` (architecture §15)

```ts
// log/log.ts
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}
export function makeLogger(opts: {
  runId: string,
  debugFilePath?: string,
  clock: Clock
}): Logger;

// redaction/patterns.ts
export const REDACTION_PATTERNS: RegExp[] = [
  /\bgh[poesu]_[A-Za-z0-9]{36,}\b/g,                                  // GitHub PAT
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,                                    // GitLab PAT
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,                                   // Anthropic
  /\bxox[bpoa]-[A-Za-z0-9-]{10,}\b/g,                                 // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                                            // AWS access key
  /Authorization:\s*Bearer\s+\S+/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,               // JWT
  /([A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z_]*\s*[:=]\s*)["']?[^"'\s]+/g, // generic
];

// redaction/redact.ts
export interface Redactor {
  redact(s: string): string;
  redactStream(input: NodeJS.ReadableStream): NodeJS.ReadableStream;
}

// Builder injecting literal-value tokens captured at CLI startup. The
// literal-value strategy (architecture §15.4) is the load-bearing path for
// auth credentials whose prefix shape is not contractual; prefix regexes
// in REDACTION_PATTERNS are the defense-in-depth floor.
export function makeRedactor(opts: { extraLiterals?: string[] }): Redactor;

// Default callable bindings for code wired before makeRedactor is available
// (e.g., pre-`Logger` `cli.ts` error paths). These run with the regex set only,
// no literals.
export function redact(s: string): string;
export function redactStream(input: NodeJS.ReadableStream): NodeJS.ReadableStream;
```

The redaction set errs toward over-masking (architecture §15.4). Order matters:
specific patterns first, generic last.

**Literal-value injection contract (FR-15, architecture §15.4, §20.2).**
`cli.ts` reads the auth-credential value at startup (one env read, before any
subprocess spawns), passes it as `extraLiterals` to `makeRedactor`, and threads
the resulting `Redactor` into both `makeLogger` and the runner factory.
Literals shorter than 8 characters are dropped silently (otherwise an
accidentally-empty or trivial literal would mask harmless substrings); the
dropped count is logged at INFO. Literals are escaped for regex use before
compilation. The literal patterns run *before* the regex set so a known token
value is masked even if it doesn't match any prefix family.

Eight chars is the implementer's floor, not a spec-level invariant — tighten
or expose as a knob if a real-world short-token case emerges.

**Chokepoint contract (load-bearing).** Every emission from `Logger.info` and
`Logger.debug` passes through `redact()` before being written to stdout or to
the debug file. The runner's transcript capture pipes child stdio through
`redactStream()` before any disk write. There is no other path to stdout, the
debug log file, or any per-target transcript file. CI lint: grep `src/` for
`process.stdout.write`, `process.stderr.write`, `console.log`, `console.error`,
and `fs.writeFile*` of paths matching `*.log`/`*.transcript` outside `src/log/`
and `src/runner/agent-host.ts`; either is a fail. `cli.ts` may use `console`
only for `--help` text and exit-time error messages, both pre-`Logger`.

### 5.3 `routing` (architecture §9, FR-6)

```ts
export type Tier = 1 | 2 | 3;
export type Severity = "low" | "medium" | "high";
export type Priority = "low" | "medium" | "high";
export interface RoutingResult {
  branch: boolean;
  priority: Priority;
  basePriority: Priority;
  bumpReason: string;                  // "none" or human-readable
}
export function route(tier: Tier, severity: Severity): RoutingResult;
```

Implementation: a closed-set switch over tier (the outer dispatch is one of the
flat-dispatch exemptions in CLAUDE.md). Pure, no I/O. The reporter, manifest
renderer, and issue-body builder all import this single function.

The 9-cell table (FR-6 + decision 10):

| Tier | Severity | branch | priority | basePriority | bumpReason |
|---|---|---|---|---|---|
| 1 | * | true | high | high | "none" |
| 2 | low | true | medium | medium | "none" |
| 2 | medium | true | medium | medium | "none" |
| 2 | high | true | high | medium | "base medium → high because severity_self_rated=high" |
| 3 | low | false | low | low | "none" |
| 3 | medium | false | medium | low | "base low → medium because severity_self_rated=medium" |
| 3 | high | false | medium | low | "base low → medium because severity_self_rated=high" |

### 5.4 `identity` / fingerprint (architecture §11, decision 9)

```ts
export interface FingerprintInput {
  category: string;
  snippet: string;                     // code window relevant to the finding
}
export function fingerprint(input: FingerprintInput): string;     // 12 lower-hex chars
export function infraNamespace(fp: string): string;               // `${fp}:infra`
```

Implementation:

```ts
crypto.createHash("sha256")
      .update(`${input.category}\n${normalize(input.snippet)}`)
      .digest("hex").slice(0, 12)
```

`normalize` rules (frozen after Phase 1; a change is a `schema_version` bump):
- Strip line comments (`// …`, `# …`) and block comments (`/* … */`).
- Collapse runs of whitespace to a single space; trim.
- Preserve identifiers and string literals as-is.
- Language-agnostic.

### 5.5 `config`

```ts
export type AuthMode = "api_key" | "subscription";

export interface ResolvedConfig {
  /* matches config.schema.json + secrets-from-env */
  auth: { mode: AuthMode };
}
export interface CliFlags {
  concurrency?: number;
  scope?: "hint_only" | "hint+verify" | "repo_wide";
  configPath?: string;
  runId?: string;
  dryRun?: boolean;
  authMode?: AuthMode;                   // FR-10 / FR-15 override
}
export function loadConfig(opts: {
  configPath: string,
  flags: CliFlags,
  env: NodeJS.ProcessEnv
}): ResolvedConfig;

// FR-15: capture the credential by literal value at startup so the redaction
// builder (§5.2) can mask it everywhere. Returns the token string and the
// env-var name it was read from. Skipped on dry-run.
export function resolveAuthCredential(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv
): { tokenValue: string, envVarName: "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN" };
```

Override precedence (highest wins): CLI flags > env > file. Unknown keys at any
level throw with file:line:col. `output.mode=local` ⇒ one warning that VCS keys
are ignored. Token presence is checked here, *except* when `flags.dryRun` is
true — `--dry-run` resolves discovery without requiring tokens (no agents are
spawned and no reporter calls are made; see §5.11). The actual token value is
read via `env[config.vcs.source_token_env]` (forge) or the FR-15 helper above
(agent auth) and never persisted.

**`auth.mode` env-var override (FR-15 / FR-9 precedence).** The env name is
`LBVD_AUTH_MODE`, matching the existing `LBVD_*` prefix
(`LBVD_RUNNER`, `LBVD_SUBSTRATE`). Unknown values produce the
same config-error path as a malformed file value. CLI flag `--auth-mode` wins
over `LBVD_AUTH_MODE`, which wins over the file's `auth.mode`.

**`ResolvedConfig.auth` carries the mode only.** Never the token value. The
token is captured separately by `resolveAuthCredential` and used only for
redaction-literal injection and for the `safe-env` chokepoint; it is not
persisted to `state.json` or `config.snapshot.yaml`. A unit test asserts the
snapshot does not contain the OAuth token literal.

**Resume mode-mismatch (architecture §20.6).** On `resume`, after loading
`state.json` (no run-dir mutation yet, per §5.10) the dispatcher compares
the snapshot's `auth.mode` against the re-resolved current `auth.mode`.
Mismatch ⇒ exit 3 with an "auth-mode mismatch" message. Token *value*
differences under the same mode are accepted — only the mode is
snapshot-pinned. Snapshot shapes the dispatcher must tolerate:
- `auth` absent (pre-F5 snapshot) → treat snapshot as `api_key` and
  compare.
- `auth` malformed (non-object, non-string `mode`, unknown enum) → refuse
  with a generic "config_snapshot.auth is corrupt" message; **do not echo
  the attacker-supplied value** (state.json is untrusted on resume).

### 5.6 `discovery` + `blacklist` (FR-1, FR-2)

```ts
export interface DiscoveryOptions {
  mode: "scan-all" | "scan-changes",
  cwd: string,
  config: ResolvedConfig
}
export interface TargetList {
  targets: string[],
  exclusions: { path: string, layer: ExclusionLayer }[]
}
export type ExclusionLayer = "gitignore" | `builtin:${BuiltinGroup}` | "user";
export type BuiltinGroup =
  | "lockfiles" | "vendored" | "build_outputs" | "minified"
  | "binary_assets" | "generated_code" | "oversized";
export async function enumerate(opts: DiscoveryOptions): Promise<TargetList>;
```

Built-in groups (each a list of glob patterns; specific patterns finalized at
implementation time but stable thereafter):

- `lockfiles`: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`,
  `Gemfile.lock`, `poetry.lock`, `composer.lock`, etc.
- `vendored`: `vendor/`, `third_party/`, `node_modules/`.
- `build_outputs`: `dist/`, `build/`, `out/`, `.next/`, `target/`, `*.o`, `*.a`.
- `minified`: `*.min.js`, `*.min.css`.
- `binary_assets`: `*.png`, `*.jpg`, `*.pdf`, `*.zip`, `*.wasm` (full list in
  `src/discovery/blacklist.ts`).
- `generated_code`: `*.pb.go`, `*_pb2.py`, files starting with
  `// Code generated by` / `# Generated by` (read first 2 lines).
- `oversized`: any file > 2 MB (configurable via reserved key, NFR-5).

`scan-changes` runs `git diff --name-only --cached --diff-filter=ACMR` via
`child_process.execFile`. Empty list ⇒ `targets=[]`, dispatcher exits cleanly
with code 5 (informational; FR-1 acceptance).

Each excluded file is logged once at INFO with the matching layer.

### 5.7 `runner` interface + implementations (architecture §2, §18.1, §19.3)

```ts
export type Capability = "fs:read" | "fs:write" | "net" | "shell";

export interface RunnerInput {
  runDir: string,                      // absolute
  targetSubtree: string,               // absolute path under runDir/targets/
  targetFile: string,                  // relative to repoRoot
  repoRoot: string,                    // absolute
  stage: 1 | 2,
  capabilities: Capability[],
  scanScope?: "hint_only" | "hint+verify" | "repo_wide",   // stage 1 only
  finding?: Finding,                   // stage 2 only (passed via stdin or args)
  budgetSeconds: number,
  redactedEnv: NodeJS.ProcessEnv,
  logger: Logger
}
export interface RunnerExit {
  code: number,
  signal: NodeJS.Signals | null,
  wallSeconds: number
}
export interface Runner {
  spawn(input: RunnerInput): Promise<{ pid: number, done: Promise<RunnerExit> }>;
  abort(pid: number, gracefulMs?: number): Promise<void>;   // SIGTERM, SIGKILL after gracefulMs (default 5000)
}
```

**`sdk-runner.ts`.** Spawns
`child_process.spawn("npx", ["-y", "tsx", "./src/runner/agent-host.ts"], { stdio: ["pipe","pipe","pipe"], env: redactedEnv, cwd: <see below> })`.
Sends `RunnerInput` as JSON on stdin.

**`safe-env.ts` (FR-15 chokepoint, architecture §20.2).** Today the module
unconditionally forwards every member of `SDK_AUTH_ALLOWLIST` whose value is in
`process.env`. FR-15 *gates* the auth subset of that allowlist by
`config.auth.mode`. The contract becomes `(mode, env) → only-the-mode's-credential`.

```ts
// Anthropic auth env vars whose forwarding is gated by auth.mode.
const ANTHROPIC_AUTH_VARS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

// Per-mode forwarded subset of ANTHROPIC_AUTH_VARS.
const MODE_AUTH_FORWARD: Record<AuthMode, ReadonlySet<string>> = {
  api_key:      new Set(["ANTHROPIC_API_KEY"]),
  subscription: new Set(["CLAUDE_CODE_OAUTH_TOKEN"]),
};
```

`buildAgentEnv` iterates `SDK_AUTH_ALLOWLIST` and applies, in order:

1. If the key is in `ANTHROPIC_AUTH_VARS` and *not* in
   `MODE_AUTH_FORWARD[config.auth.mode]` → drop. Empty-string and unset are
   treated identically (both are non-forwards).
2. Otherwise (Bedrock/Vertex/AWS/GCP env vars) → forward as before. The
   `auth.mode` enumeration is `api_key | subscription` in v1; cloud-provider
   env vars remain forwarded unchanged until a future mode graduates them
   (architecture §20.2, decision 24).
3. The forge-token `denyList` is unchanged — VCS credentials remain scrubbed
   regardless of mode (architecture §1.3.1, §20.2).

The function signature stays `(opts: BuildOpts) → NodeJS.ProcessEnv`; `opts.config`
already carries `auth.mode`. No new parameter is added.

CI lint: grep `src/runner/agent-host.ts` and `src/runner/sdk-runner.ts` for any
direct `process.env.ANTHROPIC_API_KEY` / `process.env.CLAUDE_CODE_OAUTH_TOKEN`
read — fail. Auth env reads must go through `buildAgentEnv` only.

An empty-string value for the *selected* mode's env var is treated as unset by
`safe-env` (forwards nothing). This is unreachable in normal operation because
`resolveAuthCredential` (§5.5) already aborted the run; the symmetric handling
is defense-in-depth.

**Runner factory threading.** `makeSdkRunner` and `makeFixtureRunner`
accept a `Redactor` instance and use it for `redactStream` on the
subprocess stdout/stderr — *not* the module-level `redactStream` export.
The redactor passed in is the same one threaded into `makeLogger` from
`cli.ts`, so logs and transcripts share the same masked-literal set. The
module-level `redact` / `redactStream` exports remain as a no-literal
fallback for pre-`Logger` callers (e.g., `cli.ts` error paths).

**Capability boundary enforcement (load-bearing; architecture §1.3.1, §7.3).**
The Claude Agent SDK does not natively enforce path-scoping for `Write`/`Edit`
or temporal scope for `Read`. Therefore `agent-host.ts` is the
**enforcement layer**: it wraps every SDK tool call in a pre-flight validator
that consults the capability set before forwarding to the SDK.

- Tool not in capability set → error to the agent immediately, no SDK call.
- `Read`/`Glob`/`Grep`: the resolved absolute path must be within `repoRoot`.
  When `scanScope=hint_only` the path must equal `<repoRoot>/<targetFile>`.
- `Write`/`Edit`: the resolved absolute path must be within `targetSubtree`.
- `Bash`: stage-1 agents do not have it; stage-2 agents inherit cwd
  `targetSubtree` and the host blocks shell redirections that escape the prefix
  (best-effort: shell-redirection escapes are caught only when the redirected
  path is statically resolvable; dynamic constructs are out of scope for v1).
  The default cwd is `targetSubtree`; agents that
  need to invoke project test commands receive the project root via a CLI
  argument the agent-host whitelists for read execution.

Capability → SDK tool grants:

| Capability | SDK tool grants |
|---|---|
| `fs:read` | `Read`, `Glob`, `Grep` (path validated; scope per `scanScope`) |
| `fs:write` | `Write`, `Edit` (path must be within `targetSubtree`) |
| `net` | `WebFetch`, `WebSearch` |
| `shell` | `Bash` (cwd pinned to `targetSubtree`; `LBVD_REPO_ROOT` env exposed for read-execute of project tooling) |

Stage-1 capability set: `["fs:read"]`. Stage-2 capability set: all four.
Package installation is a side effect of `shell` (no separate capability).
`scanScope=hint+verify` is enforced as `repo_wide` at the capability layer (the
SDK has no notion of "candidate identified"); the prompt is the only nudge for
the temporal split. The no-network and no-write rules — the load-bearing parts
— are enforced at the host wrapper, not at the prompt.

**Read-execute boundary for stage 2.** The agent's `Bash` cwd is the
per-target subtree, but the project's test framework typically expects to run
from the repo root. The agent-host therefore exposes `LBVD_REPO_ROOT` as
an environment variable available to every `Bash` invocation. The agent is free
to `cd "$LBVD_REPO_ROOT" && <test-cmd>` for read-execute use; the
write-path validator continues to reject any `Write`/`Edit` outside
`targetSubtree`. This preserves the write-boundary invariant while making the
project's tooling reachable.

Transcripts are captured via `redactStream(child.stdout)` and
`redactStream(child.stderr)` and written to
`<targetSubtree>/stage{1,2}.transcript`. Pre-redaction text never touches disk
(architecture §15.3).

**Token-usage emission contract.** The runner is responsible for measuring and
recording token usage as part of writing `finding.json` (stage 1) and
`outcome.json` (stage 2). For the SDK runner, `agent-host.ts` reads token
counts from the SDK's per-message metadata callback and writes them into the
output file before exit. For the fixture runner, the pre-canned files already
contain the counts and the runner copies them through. The schema fields in
§3.2 (`stage1_token_usage`) and §3.3 (`stage2_token_usage`, `stage2_wall_seconds`)
are sourced exclusively here.

**`fixture-runner.ts`.** Reads
`tests/fixtures/canned-agents/<scenario>/<targetFile>/{finding,outcome}.json`
plus any artifact files, copies them into `<targetSubtree>`, and exits. Selected
via `LBVD_RUNNER=fixture` env var, with the scenario name in
`LBVD_FIXTURE_SCENARIO`. Real subprocess; not in-process (architecture
§3.6, §19.3).

**Production guard.** When the fixture runner is selected, the dispatcher emits
a non-redacted INFO line at startup: `RUNNER=fixture (fixture data only; not a
real scan)`. Additionally, when `output.mode=vcs` AND
`LBVD_RUNNER=fixture`, the dispatcher refuses to run unless
`LBVD_ALLOW_FIXTURE_VCS=1` is also set; otherwise exits with code 3 and a
message naming the conflict. This prevents a misconfigured CI from publishing
fixture-derived findings to a real forge.

### 5.8 `stage1` and `stage2` invocation (architecture §7, §8)

```ts
// stage1/invoke.ts
export async function invokeStage1(opts: {
  targetFile: string,
  runDir: string,
  targetSubtree: string,
  config: ResolvedConfig,
  runner: Runner,
  clock: Clock,
  logger: Logger
}): Promise<
  | { kind: "vulnerability", finding: Finding }
  | { kind: "no_finding", finding: Finding }
  | { kind: "failed", error: string }
>;

// stage2/invoke.ts
export async function invokeStage2(opts: {
  finding: Finding,
  runDir: string,
  targetSubtree: string,
  config: ResolvedConfig,
  runner: Runner,
  clock: Clock,
  logger: Logger
}): Promise<
  | { kind: "ok", outcome: Outcome }
  | { kind: "failed", error: string }
>;
```

Each invocation: spawn → wait for exit (with budget timer, §5.10) → read the
expected file → schema-validate → for stage 2 also run `tier-validate.ts` →
return.

**Wall-clock-kill cleanup (stage 2).** When the dispatcher's per-finding cap
fires, after `runner.abort()` returns:
- The dispatcher overwrites whatever `outcome.json` the agent may have left
  with the synthesized tier-3 record
  (`tier=3, confidence=0, downgrade_reason="wall_clock_cap"`, architecture §8.6).
- The dispatcher deletes any `exploit.*` and `unit-test.*` artifact files in
  the per-target subtree (a partial agent run may have created misleading ones).
- The transcript file is preserved (post-redaction) for audit (NFR-3).

**Stage-1 budget overrun** is recorded as `failed` (no synthesized finding —
stage-1 absence-of-output is the failure signal per architecture §7.2).

### 5.9 `reporter` (architecture §10)

```ts
export interface BranchSpec {
  name: string,
  baseBranch: string,
  files: { path: string, content: string }[],
  commitMessage: string,
  targetRepo: "source" | "exploit_target"
}
export interface IssueSpec {
  kind: "finding" | "infra" | "tracking",
  title: string,
  body: string,                        // contains hidden marker for finding/infra
  labels: string[],
  targetRepo: "source" | "exploit_target"
}
export interface Reporter {
  verifyAccess(): Promise<void>;       // throws on failure → CLI exits with 3
  findBranch(name: string, repo: "source" | "exploit_target"):
    Promise<{ url: string } | null>;
  pushBranch(spec: BranchSpec): Promise<{ url: string }>;
  findIssueByMarker(marker: string, repo: "source" | "exploit_target"):
    Promise<{ url: string, state: "open" | "closed" } | null>;
  openIssue(spec: IssueSpec): Promise<{ url: string }>;
}
export function selectReporter(config: ResolvedConfig, clock: Clock, logger: Logger): Reporter;
```

`findBranch` returns the URL when the branch exists so resume can recover
`branch_url` after a crash between `pushBranch`'s return and the persistence
write (gap pattern called out by §5.10's algorithm). **Forge reporters derive
the URL deterministically** from `(repo, name)` — `https://github.com/<owner>/<repo>/tree/<branch>`
on GitHub, the equivalent on GitLab. No API round-trip is made. This means
resume does not need a forge token to recover `branch_url`. The "branch was
manually deleted between push and resume" edge case is benign: derivation
returns a URL, resume proceeds to `openIssue`, and any subsequent re-push
(which would only happen if `branch_url` was *not yet* persisted) goes through
`pushBranch`'s idempotent semantics. The Local reporter computes URLs as
`file://<absolute-path>`.

`issue-body.ts` is a pure function:

```ts
export function renderIssueBody(input: {
  finding: Finding,
  outcome: Outcome | null,             // null only for infra issues without finding context
  routing: RoutingResult,
  branchUrl: string | null,
  runId: string,
  trackingUrl?: string                 // for tracking issue body
}): string;
```

The body fields and order follow FR-7. The hidden marker is exactly one line:
`<!-- lbvd:fp:<fingerprint> -->` for finding issues,
`<!-- lbvd:fp:<fingerprint>:infra -->` for infra issues. No tracking issue
gets a marker (architecture §11.4).

`branch-name.ts`:

```ts
export function branchName(tier: 1 | 2, fingerprint: string): string {
  return `lbvd/${tier === 1 ? "exploit" : "test"}/${fingerprint}`;
}
```

No timestamps, no random suffixes (architecture §10.5).

**Sensitive-repo split** is handled inside `github.ts` / `gitlab.ts`: when
`vcs.exploit_target_repo` is non-empty, finding issues and branches go to the
target repo and a tracking issue (no marker) goes to the source repo. The
two-token split is realized at `verifyAccess()` and per-call by selecting the
right token from env keyed on `targetRepo`.

**`http.ts`** — `undici` client wrapping both forges:
- Timeout: 30 s.
- Retries: 3, exponential backoff 1s / 2s / 4s.
- Retry on: 5xx, 429, network errors.
- No retry on: 4xx (except 429).
- Tokens read from configured env vars at request time; logged-line content
  passes through `redact()`.

**Local reporter (`local.ts`).** Implements the same interface against
`<runDir>/local-report/`:
- `verifyAccess()` ensures the dir is writeable.
- `findBranch` returns `{ url: "file://<abs-path>" }` if
  `local-report/branches/<name>/` exists, else null.
- `pushBranch` writes the file set into `local-report/branches/<name>/`.
- `findIssueByMarker` greps `local-report/issues/*.md` (and
  `local-report/infra-issues/*.md` for infra namespace) for the exact marker
  string. Issue state is always `"open"` (no close concept locally).
- `openIssue` writes a markdown file under the appropriate subdir; URL is
  `file://<absolute-path>`.

### 5.10 `dispatcher` (architecture §3, §5)

```ts
// dispatcher/index.ts
export async function run(opts: {
  config: ResolvedConfig,
  clock: Clock,
  runId: string,
  mode: "scan-all" | "scan-changes" | "resume",
  resumeRunId?: string,
  cwd: string,
  logger: Logger
}): Promise<{ exitCode: number }>;
```

High-level algorithm. The gating steps (auth-mode mismatch, substrate
preflight) run **before** any filesystem mutation so a rejected resume leaves
the run dir untouched (architecture §20.4, §20.6):

1. Resolve `runDir`. If resume, load (validate) `state.json` without
   mutating the run dir. Else initialize a new run directory and write
   `config.snapshot.yaml`.
2. Truncate `active.json`.
3. **Resume auth-mode check** (resume only). Compare
   `state.config_snapshot.auth.mode` against the current resolved
   `config.auth.mode`. Mismatch ⇒ exit 3, no agents spawned, no run-dir
   mutation (architecture §20.6). When `state.config_snapshot.auth` is
   absent (pre-F5 snapshot), treat the snapshot mode as the v1 default
   `api_key`. A malformed `auth` block (non-object, non-string `mode`,
   unknown enum value) refuses with a generic "config_snapshot.auth is
   corrupt" message — the attacker-supplied value is **not** echoed
   (state.json is untrusted on resume per architecture §1.3).
4. **Substrate gate** (FR-14 + FR-15). On web-sandbox: refuses
   `auth.mode: api_key` (exit 2, substrate-specific reason, architecture
   §20.4) *and* refuses oversized runs (FR-14). On DIY-cloud: skipped.
5. **Reconcile in-flight states** (resume only — first filesystem
   mutation). For each target whose state is non-terminal:
   - `stage1_running`: remove `targets/_pending/<sha1(target)>/` entirely;
     demote state to `queued`. Stage 1 has no sealed fingerprint yet
     (architecture §5.3 — agents are not internally resumable).
   - `stage2_running`: preserve `targets/<fingerprint>/finding.json`
     (the fingerprint seal is sticky per architecture §7.5). Delete
     `outcome.json`, `exploit.*`, `unit-test.*`. State stays
     `stage2_running`; the pipeline re-enters from `invokeStage2`.
   - `reporting_branch`, `reporting_issue`, `reporting_infra`,
     `reporting_tracking`: leave state in place. The pipeline algorithm's
     idempotent reconciliation handles re-entry (see below).
   - Sweep `targets/_pending/*` orphans into `targets/_orphans/`.
6. Empty-targets exit (exit 5) if `state.targets` has no entries.
7. Build the reporter via `selectReporter()`. Call `verifyAccess()` → on
   failure, exit 3 (FR-7).
8. Compute target list:
   - new run: `state.targets` is the enumerated set from step 1.
   - resume: targets in non-terminal states (post step 5) are the work
     queue.
9. Run main loop (next subsection).
10. After loop: walk `targets/*` to build manifest
    (`manifest.buildManifest()`), render markdown, write both, set
    `state.ended_at`, return exit code.

**CLI ordering.** Auth-credential resolution is *not* a dispatcher step —
it lives in `cli.ts` so the literal-value redactor is threaded into
`makeLogger` and the runner factory before the dispatcher is constructed.
`cli.ts:buildStartup` does: `parseFlags` → `loadConfig` →
(unless fixture runner or `--dry-run`) `resolveAuthCredential` →
`makeRedactor({ extraLiterals: [tokenValue] })` →
`makeLogger({ ..., redactor })` →
`runDispatcher({ config, redactor, logger, ... })`. Missing or blank
credential aborts here with exit 3 before any further work. Fixture
runner and `--dry-run` skip credential resolution (architecture §20.3 —
no SDK subprocess, no credential to mask).

Main loop (`dispatcher/index.ts` driving `dispatcher/pipeline.ts`):

```
while workQueue non-empty AND no run-budget kill:
  while slot available AND workQueue non-empty:
    target = workQueue.pop()
    spawn pipeline(target)
  await any pipeline completion
  on completion: state transition; if terminal, free slot
```

**Pipeline orchestration (`dispatcher/pipeline.ts`).** Every state transition is
an atomic `state.json` write (write-temp-then-rename). Every URL produced by the
reporter is persisted to `state.targets[t].*_url` *before* the next state
transition. This ordering is what makes resume idempotent (architecture §5.4).

```
pipeline(target):

  if state == queued:
    state := stage1_running                                           [persist]
    result := invokeStage1(target)
    if result.kind == "no_finding":
      state.targets[t].fingerprint := result.finding.fingerprint
      state := no_finding                                              [persist; terminal]
      return
    if result.kind == "failed":
      state.targets[t].error := <summary>
      state := failed                                                  [persist; terminal]
      return
    # vulnerability:
    rename _pending/<sha1(target)> → <fingerprint>
    state.targets[t].fingerprint := result.finding.fingerprint        [persist]
    # (rename + persist must be in this order so a crash leaves
    #  either a recoverable _pending or a fingerprint-pinned subtree)

  if state in {stage1_running, stage2_running}:
    # stage1_running here means resume re-entered after the demotion in
    # step 3 already moved it to queued; if we observe stage1_running
    # at this point it's a logic error.
    state := stage2_running                                            [persist if not already]
    result := invokeStage2(finding)
    if result.kind == "failed":
      state.targets[t].error := <summary>
      state := failed                                                  [persist; terminal]
      return
    state := stage2_done                                               [persist]

  if state == stage2_done:
    routing := route(outcome.tier, finding.severity_self_rated)
    if routing.branch:
      state := reporting_branch                                        [persist]
      # Idempotent: check first, push if missing.
      existing := reporter.findBranch(name, repo)
      url := existing?.url ?? (await reporter.pushBranch(spec)).url
      state.targets[t].branch_url := url                               [persist]
    state := reporting_issue                                           [persist]

  if state == reporting_issue:
    marker := finding-marker(fingerprint)
    existing := reporter.findIssueByMarker(marker, repo)
    if existing && existing.state == "open":
      url := existing.url
    else:
      url := (await reporter.openIssue(finding-spec)).url
    state.targets[t].issue_url := url                                  [persist]
    if outcome.infra_requirements:
      state := reporting_infra                                         [persist]
    elif config.vcs.exploit_target_repo:
      state := reporting_tracking                                      [persist]
    else:
      state := done                                                    [persist; terminal]
      return

  if state == reporting_infra:
    marker := infra-marker(fingerprint)
    existing := reporter.findIssueByMarker(marker, repo)
    url := existing?.url ?? (await reporter.openIssue(infra-spec)).url
    state.targets[t].infra_issue_url := url                            [persist]
    if config.vcs.exploit_target_repo:
      state := reporting_tracking                                      [persist]
    else:
      state := done                                                    [persist; terminal]
      return

  if state == reporting_tracking:
    # Tracking issues have no marker; resume idempotency relies on
    # state.targets[t].tracking_issue_url being null vs. set.
    if state.targets[t].tracking_issue_url == null:
      url := (await reporter.openIssue(tracking-spec)).url
      state.targets[t].tracking_issue_url := url                       [persist]
    state := done                                                      [persist; terminal]
```

**About `findIssueByMarker` and the `closed` branch.** When `existing.state ==
"closed"` the post-MVP behavior (FR-8) is to file a new issue with a
`Previously reported (closed): <URL>` line. In MVP (§11) the engine treats
`closed` as "no match" and proceeds to `openIssue` — the linked-to-closed flow is
deferred. Both behaviors share this code path; the fork lives behind a feature
flag flipped on when dedup ships.

`dispatcher/slot.ts` — counting semaphore around `concurrency`. Slot acquired
before stage-1 spawn, released only on terminal state.

`dispatcher/budget.ts`:
- **Per-finding stage-2 cap.** A `setTimeout` per stage-2 invocation, started
  when stage 2 spawns. On fire, `runner.abort(pid)` is called; the
  synthesized tier-3 outcome is persisted (§5.8 cleanup rules).
- **Run-level budget.** A single timer. On fire, the dispatcher iterates its
  **in-process spawn set** (the set of `{pid, runner}` it tracks from each
  `runner.spawn(...)` return; architecture §6.1 — `active.json` is observation,
  not authority), calls `runner.abort(pid, gracefulMs=10000)` on each (SIGTERM
  followed by SIGKILL after 10 s), waits for all `done` promises, writes the
  termination record to `state.terminations`, returns exit code 4.

**Signal shutdown (F6, architecture §21). Implemented alongside the run-level budget in `dispatcher/loop.ts`.**

`setupSignalHandlers` — extracted helper called from `runPipelineLoop` before the queue loop starts. Signature:

```ts
function setupSignalHandlers(opts: {
  inflightSpawns: Set<SpawnHandle>;
  runner: Runner;
  logger: Logger;
}): { killed: () => boolean; signal: () => "SIGINT" | "SIGTERM" | null; cleanup: () => void }
```

The helper registers **separate** handlers for SIGINT and SIGTERM (each via `makeHandler(sig)`), capturing the signal name via closure rather than from the handler argument (Node.js does not pass the signal name as an argument to process signal listeners). The handler's first action is `if (killed) return` (architecture §21.3 one-shot rule — removing the listener inside the handler causes Node.js to re-apply the default exit-130 action immediately after the handler returns). It then sets the killed flag, logs `"signal_shutdown.fired"`, and calls `abortAllInflight` with context string `"signal_shutdown"` so abort-failure logs read `"signal_shutdown.abort_failed"` (architecture §21.7).

`cleanup()` removes both listeners (called in the `finally` block after `Promise.all([...inflight])`, on every exit path).

Changes to `abortAllInflight` in `loop.ts`:

```ts
async function abortAllInflight(
  inflightSpawns: Set<SpawnHandle>,
  runner: Runner,
  logger: Logger,
  context: string,   // new: "run_budget" | "signal_shutdown"
): Promise<void>
```

The existing call from the budget timer passes `"run_budget"`. The signal handler passes `"signal_shutdown"`. The debug log key becomes `` `${context}.abort_failed` ``.

Changes to `runPipelineLoop` body:

1. Call `setupSignalHandlers(...)` before the queue loop; bind result to `signalShutdown`.
2. In `start(target)`: add `|| signalShutdown.killed()` to the early-exit guard after `slots.acquire()`.
3. In the queue loop: add `|| signalShutdown.killed()` to the `if (runBudgetKilled) break` check.
4. After `await Promise.all([...inflight])`: move the existing `clearTimeout(runBudgetTimer)` call (currently unconditional on line 113 of `loop.ts`) into a `finally` block along with `signalShutdown.cleanup()`. Both must be in the same `finally` so they fire on every exit path — including a throw before `Promise.all` resolves. Specifically:
   ```ts
   try {
     await Promise.all([...inflight]);
   } finally {
     clearTimeout(runBudgetTimer);
     signalShutdown.cleanup();
   }
   ```
5. After the budget-kill check block, add the signal-killed path. **`exactOptionalPropertyTypes: true` is active** — assigning `undefined` to an optional property is a type error. Capture the signal value once and spread conditionally:

```ts
if (signalShutdown.killed()) {
  const sig = signalShutdown.signal();
  const term: Termination = {
    kind: "user_interrupt",
    at: opts.clock.now().toISOString(),
    reason: `run interrupted by ${sig ?? "unknown"} signal`,
  };
  if (sig !== null) term.signal = sig;
  opts.state.terminations.push(term);
  saveState(opts.runDir, opts.state);
  return { exitCode: 6 };
}
```

If both `runBudgetKilled` and `signalShutdown.killed()` are true (race between timer and signal), the budget-kill check runs first and exits with code 4; the signal path is unreachable. Both paths record terminations correctly for their respective callers.

### 5.11 `cli` (architecture §13, FR-10)

```
lbvd scan-all      [--config X] [--concurrency N] [--scope ...] [--dry-run] [--run-id ID] [--auth-mode api_key|subscription]
lbvd scan-changes  [same flags]
lbvd resume <run-id>  [--config X] [--auth-mode ...]   # --auth-mode must match the snapshot or the run aborts (FR-15, §20.6)
lbvd report  <run-id>
```

Exit code table (architecture §13.2 — stable contract):

| Code | Meaning |
|---|---|
| 0 | Run completed successfully |
| 1 | Generic error / dispatcher crash |
| 2 | Preflight refused (oversized run on web-sandbox) |
| 3 | Config invalid (unknown key, missing required token, write-access check failed) |
| 4 | Run-budget killed |
| 5 | No targets after discovery (informational; FR-10 acceptance) |
| 6 | Run interrupted by SIGINT or SIGTERM (FR-16) |

`--dry-run`:
1. Parse config (token presence checks skipped per §5.5).
2. Run discovery + blacklist.
3. Print resolved target list (one path per line) to stdout, exclusion table to stderr.
4. Exit 0. No run directory created. No agents spawned. No reporter
   `verifyAccess()` call.

### 5.12 `manifest` (architecture §16, FR-13)

```ts
export async function buildManifest(opts: {
  runDir: string,
  state: RunState,
  clock: Clock
}): Promise<Manifest>;

export function renderManifestMarkdown(manifest: Manifest): string;
```

`buildManifest` walks `targets/*/{finding,outcome}.json` (each read via
schema-validation; malformed entries fold into the `errors` list). Token-usage
aggregates use `simple-statistics` algorithms inlined (no extra dep) since the
arithmetic is straightforward. Histogram bucketing for confidence is fixed at 101
buckets (0..100); for token counts, log-scale buckets at 0, 1k, 10k, 100k, 1M, 10M+.

`report` subcommand re-runs `buildManifest()` from the persisted `state.json` and
the per-target subtrees (architecture §16.2).

### 5.13 `substrate`

```ts
export type Substrate = "web-sandbox" | "diy-cloud";
export function detectSubstrate(env: NodeJS.ProcessEnv): Substrate;
export function preflight(opts: {
  targets: string[],
  cwd: string,
  config: ResolvedConfig,
  substrate: Substrate
}): { ok: true } | { ok: false, reason: string };
```

`detectSubstrate`: returns `"web-sandbox"` if
`env.LBVD_SUBSTRATE === "web-sandbox"`; else `"diy-cloud"`. The marker is
exported by the slash-command bootstrap itself (§5.14) — the engine does not
sniff Claude-Code-internal env vars, so a rename inside the host platform does
not break detection. DIY-cloud invocations leave the marker unset.

`preflight`: skipped if `substrate !== "web-sandbox"`. Otherwise checks, in order:

1. **Auth mode (FR-15, architecture §20.4).** `config.auth.mode === "api_key"`
   ⇒ `{ ok: false, reason: "web sandbox requires auth.mode: subscription; ANTHROPIC_API_KEY is ignored in this substrate" }`.
   The substrate gate owns this rule; the auth seam itself stays
   substrate-unaware. The check runs *before* the size checks so an operator
   with the wrong mode learns immediately, regardless of repo size.
2. **Target count and tree size.** Computes `targets.length` and total
   `fs.statSync` byte size. If either exceeds the respective threshold ⇒
   `{ ok: false, reason }`. The reason string is emitted on stderr along with
   the "use DIY-cloud" recommendation (FR-14).

### 5.14 `slash-commands/lbvd.md`

Markdown body (executed as a slash command):

```sh
#!/usr/bin/env bash
set -euo pipefail

# Token preflight — at least one VCS token must be present.
if [ -z "${GITHUB_TOKEN:-}" ] && [ -z "${GITLAB_TOKEN:-}" ]; then
  echo "LLM-based Vulnerability Detector: set GITHUB_TOKEN or GITLAB_TOKEN in the sandbox env first." >&2
  exit 1
fi

# FR-15 / architecture §20.4: web sandbox is subscription-only.
# Best-effort UX — the engine's substrate gate is the authoritative check.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "LLM-based Vulnerability Detector: web sandbox requires CLAUDE_CODE_OAUTH_TOKEN." >&2
  echo "Run 'claude setup-token' on a host with browser access, then export the token here." >&2
  exit 1
fi

# Dependency preflight — one-time install if needed.
if [ ! -d node_modules ]; then
  npm install
fi

# Substrate marker — the engine reads this; slash-command sets it explicitly so
# detection does not depend on a Claude-Code-internal env var.
export LBVD_SUBSTRATE=web-sandbox

exec npx -y tsx ./src/cli.ts "$@"
```

Help text (printed on `/lbvd --help` via the CLI itself) recommends
DIY-cloud above `--concurrency 4` or 2-hour runs (decision 7).

---

## 6. Phase status

The original 17 phases (0–16) were folded into the four-pass build of 2026-05-09:
initial implementation, post-implementation review, security review, and a
follow-up phase set covering SDK driver / AJV / stage-1 budget /
config_files blacklist / manifest wall-clock aggregation. All ship except the
two listed under **Not done** in §0 (Status). The build sequence below is a
historical reference; the actual ordering deviated where dependencies allowed
parallel work.

| Phase | Subject | Status |
|---|---|---|
| 0 | Skeleton, gitignore, deps | done |
| 1 | Pure modules: `clock`, `redaction`, `routing`, `identity` | done |
| 2 | Config + discovery + CLI dry-run | done |
| 3 | State, telemetry, slot pool | done |
| 4 | Runner interface + fixture runner | done |
| 5 | Stage 1 / Stage 2 invocation + tier-validate | done (incl. budget timer + race-success fix) |
| 6 | Local reporter + issue-body + branch-name | done |
| 7 | Dispatcher main loop + manifest build | done |
| 8 | Manifest markdown + `report` subcommand | done |
| 9 | Resume + reporter reconciliation | done |
| 10 | GitHub reporter (recorded HTTP) | done — `reporter/github.ts` + `Transport` interface in `reporter/http.ts` (replay/recording/live) + `scripts/record-http.ts` + `scripts/synth-http.ts` + `tests/reporter-contract/` + corpus under `tests/fixtures/http/github/` (synth-seeded; refresh via runbook) |
| 11 | GitLab reporter | **post-MVP** — `selectReporter()` throws |
| 12 | Sensitive-repo + dual-token + verifyAccess | done |
| 13 | SDK runner (real `@anthropic-ai/claude-agent-sdk` + capability shim) | done |
| 14 | Substrate detect + preflight | done |
| 15 | Slash command bootstrap | done |
| 16 | Hardening + lint:boundaries | done |
| F1 | AJV-backed JSON-Schema validation | done |
| F2 | Stage-1 wall-clock cap (default 120 s) | done |
| F3 | `config_files` default-blacklist group | done |
| F4 | Manifest stage1/stage2 wall-clock aggregation | done |
| F5 | Agent authentication mode — FR-15 / §20 | done — see §6.5 below |
| F6 | Graceful shutdown + intermediate manifest — FR-16 / §21 | done — see §6.6 |
| F7 | Application startup probe + serialized live verification — FR-17 / §22 | done — see §6.7 |

### 6.5 Phase F5 record — Agent authentication mode

Shipped 2026-05-10. Audit of what landed:

| # | Task | Files |
|---|---|---|
| F5.1 | `auth.mode` in config schema + `ResolvedConfig` (default `api_key`) | `schemas/config.schema.json`, `src/config/{defaults,schema,load}.ts` |
| F5.2 | `--auth-mode` CLI flag + `LBVD_AUTH_MODE` env override (precedence: CLI > env > file) | `src/cli.ts`, `src/config/load.ts` |
| F5.3 | `resolveAuthCredential(config, env)` invoked from `cli.ts:buildStartup`; missing-credential UX names the env var and corrective action; skipped on `--dry-run` and fixture runner | `src/config/load.ts`, `src/cli.ts` |
| F5.4 | `makeRedactor({ extraLiterals })` builder; `Redactor` threaded through `makeLogger` and both runner factories; module-level `redact` / `redactStream` retained as no-literal fallbacks | `src/redaction/redact.ts`, `src/log/log.ts`, `src/runner/{select,sdk-runner,fixture-runner}.ts` |
| F5.5 | `safe-env.ts` SDK-auth allowlist gated by `auth.mode` per architecture §20.2 table; `ANTHROPIC_AUTH_TOKEN` dropped in both v1 modes; Bedrock/Vertex vars forwarded unchanged | `src/runner/safe-env.ts` |
| F5.6 | Resume mode-mismatch check before any run-dir mutation; absent-snapshot defaults to `api_key`; malformed snapshot refuses with a generic message that does not echo attacker content | `src/dispatcher/run.ts` |
| F5.7 | Substrate gate runs on every dispatcher entry (resume included), before reconcile; refuses `api_key` on web-sandbox before size checks | `src/dispatcher/run.ts`, `src/substrate/preflight.ts` |
| F5.8 | Slash-command preflight for `CLAUDE_CODE_OAUTH_TOKEN`; defensive `unset ANTHROPIC_API_KEY` | `slash-commands/lbvd.md` |
| F5.9 | CI lint forbids direct `process.env.{ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN,CLAUDE_CODE_OAUTH_TOKEN}` reads (dotted, bracketed, and destructuring forms) outside `src/config/load.ts`, `src/runner/safe-env.ts`, `src/cli.ts` | `scripts/lint-boundaries.ts` |
| F5.10 | Workflow tests: env-isolation, full run-dir literal sweep (zero hits), resume mismatch, absent-snapshot defaulting, corrupt snapshot, W4 substrate refusals, token rotation under same mode | `tests/workflow/auth-mode.test.ts` |
| F5.11 | README runbook: two-mode setup, `claude setup-token`, plan tiers, ToS posture, `apiKeyHelper` hazard, W4 recommendation, resume semantics | `README.md` |

### 6.6 Phase F6 — Graceful shutdown + intermediate manifest

**Architecture:** §21 (all subsections). **Requirements:** FR-16. **Exit code:** 6.

| # | Task | Files |
|---|---|---|
| F6.1 | Extend `Termination` type: `kind: "run_budget" \| "user_interrupt"`, `signal?: "SIGINT" \| "SIGTERM"`. Update JSON schema: `kind` enum, add optional `signal` property (not in `required`). These two files must change together (architecture §21.6). | `src/dispatcher/state.ts`, `schemas/state.schema.json` |
| F6.2 | Add exit code 6 to the CLI table (comment in `src/cli.ts`; value propagated from `runPipelineLoop` result). | `src/cli.ts` |
| F6.3 | Add `context: string` parameter to `abortAllInflight` in `loop.ts`; update the existing budget-kill call site to pass `"run_budget"`. Debug log key becomes `` `${context}.abort_failed` `` (architecture §21.7). | `src/dispatcher/loop.ts` |
| F6.4 | Extract `setupSignalHandlers` helper in `loop.ts` (architecture §21.1–§21.3); register SIGINT+SIGTERM before the queue loop; call `cleanup()` in a `finally` after `Promise.all`; add `\|\| signalShutdown.killed()` gate in both the `start()` early-exit and the queue-loop `break` check. Add the signal-killed exit-code-6 path after the budget-kill path (architecture §21.2). | `src/dispatcher/loop.ts` |
| F6.5 | Workflow test: fixture run with ≥6 targets (3 pre-completed via fixture, 3 queued), deliver SIGINT after first 3 complete; assert: both manifest files exist, termination `kind = "user_interrupt"` **and** `signal = "SIGINT"`, 3 terminal outcomes with URLs, 3 queued outcomes with null numeric fields, exit code 6. Then `resume` the run-id and assert the 3 queued targets complete and the final manifest matches the no-interrupt baseline. | `tests/workflow/signal-shutdown.test.ts` |
| F6.6 | Unit test: `setupSignalHandlers` — second signal does not re-enter shutdown (double-deliver test). | `tests/unit/signal-handlers.test.ts` |

**Task dependencies:** F6.1 before F6.4 (type must be updated before the push); F6.3 before F6.4 (signature change must land before the new caller); F6.2 and F6.5–F6.6 independent after F6.4.

**Complexity note.** `runPipelineLoop` is already at non-trivial complexity. Extracting `setupSignalHandlers` as a separate named function keeps the main loop under budget. Verify after implementation with `npx tsc --noEmit` (types) and a manual complexity pass on both `runPipelineLoop` and `setupSignalHandlers`.

### 6.7 Phase F7 — Application startup probe and serialized live verification

**Architecture:** §22 (all subsections). **Requirements:** FR-17.

#### New modules and files

| # | Task | Files |
|---|---|---|
| F7.1 | `schemas/app-probe.schema.json` — AJV-compiled JSON schema for the probe output. Optional in AJV sense (the dispatcher synthesizes when missing). | `schemas/app-probe.schema.json` |
| F7.2 | `src/probe/schema.ts` — AJV-compiled validator; `src/probe/prompt.ts` — probe agent system prompt (instructs agent to inspect startup artefacts, attempt start, verify reachability, stop, write structured output). | `src/probe/schema.ts`, `src/probe/prompt.ts` |
| F7.3 | `src/probe/invoke.ts` — `invokeProbe(opts): Promise<AppProbe>`. Spawns the probe via `runner.spawnProbe(probeInput)`, enforces the `budgets.app_probe_seconds` timer (same pattern as stage-1/stage-2 budget), reads + validates `<probeSubtree>/app-probe.json`, promotes the validated result to `<runDir>/app-probe.json` (dispatcher writes this — not the agent), validates `start_commands` / `stop_commands` are non-empty string arrays. Returns synthesized `startable: false` record on budget kill or validation failure. | `src/probe/invoke.ts` |
| F7.4 | `src/app-lock/lock.ts` — `AppLock` interface + `makeAppLock` factory. Implements: `acquire(timeoutMs): Promise<boolean>` (O_CREAT\|O_EXCL loop with exponential back-off; staleness check using age `> stage2BudgetMs + mutexTimeoutMs` AND `kill(pid, 0)` returns ESRCH); `release(): Promise<void>` (unlink); `cleanupStale(stage2BudgetMs, mutexTimeoutMs): Promise<void>` (called at dispatcher startup). Lock file path: `<runDir>/app-access.lock`. Lock file content: `{ pid: number, locked_at: string }`. | `src/app-lock/lock.ts` |

#### Runner interface and implementation changes

| # | Task | Files |
|---|---|---|
| F7.5 | Add `ProbeRunnerInput` type and `spawnProbe(input: ProbeRunnerInput)` to the `Runner` interface. `ProbeRunnerInput` fields: `runDir`, `probeSubtree`, `repoRoot`, `capabilities: Capability[]`, `budgetSeconds`, `redactedEnv`, `logger`. The output path is derived from `probeSubtree` by convention (`<probeSubtree>/app-probe.json`); it is not a separate field. `stage: 1 \| 2` in `RunnerInput` is unchanged. | `src/runner/interface.ts` |
| F7.6 | `sdk-runner.ts` — implement `spawnProbe`: spawns `agent-host.ts` with `RunnerInput`-equivalent fields derived from `ProbeRunnerInput`; passes `stage: "probe"` as a discriminant so the agent-host knows it is a probe invocation and exposes the `AcquireAppLock` / `ReleaseAppLock` tools (not available to stage-1 or stage-2 agents directly; the probe agent does not need the lock — it is the only instance running at that time). The probe capability set: `["fs:read", "fs:write", "net", "shell"]` with write scoped to `probeSubtree`. Pass `probeSubtree` as the write-boundary argument to the agent-host's `canUseTool` shim (the parameter currently named `targetSubtree`). When `stage === "probe"`, the shim must enforce `confineToParent(probeSubtree)` for all fs:write tool calls. | `src/runner/sdk-runner.ts` |
| F7.7 | `fixture-runner.ts` — implement `spawnProbe`: reads `tests/fixtures/canned-agents/<scenario>/probe/app-probe.json`, writes it to `<probeSubtree>/app-probe.json`, exits. When the probe fixture file does not exist, writes a synthesized `startable: false` result. | `src/runner/fixture-runner.ts` |

#### Agent-host tool additions (Stage 2 only)

| # | Task | Files |
|---|---|---|
| F7.8 | Add two new tools to `agent-host.ts` gated on `stage === 2 AND appProbe != null AND appProbe.startable === true`: `AcquireAppLock({ timeout_seconds: number }) → { acquired: true } \| { acquired: false, reason: string }` (calls `appLock.acquire(timeout_seconds * 1000)`) and `ReleaseAppLock() → void` (calls `appLock.release()`). If `appProbe` is null when Stage 2 spawns (defensive path), treat as `startable: false` — the tools are not exposed. The `AppLock` instance is constructed by the dispatcher and passed to Stage 2 agent-host at spawn time (as a serialized lock-path + PID pair in the `RunnerInput`, so the agent-host in the subprocess can reconstruct it). `appLock` is constructed inside the Stage 2 agent-host subprocess, not shared across subprocesses — each subprocess polls the filesystem mutex independently. | `src/runner/agent-host.ts` |

#### Configuration schema changes

| # | Task | Files |
|---|---|---|
| F7.9 | Add to `budgets` in `schemas/config.schema.json` and `src/config/defaults.ts`: `app_probe_seconds: 300` (default 5 min), `app_mutex_timeout_seconds: 120` (default 2 min). Both are integers > 0. | `schemas/config.schema.json`, `src/config/defaults.ts` |

#### State schema changes

| # | Task | Files |
|---|---|---|
| F7.10 | Add optional `app_probe` top-level field to `schemas/state.schema.json`: `{ state: "pending" \| "running" \| "done", startable: boolean \| null, completed_at: string \| null }`. Not in `required` (absent = pending, per architecture §22.9). Update `RunState` type in `src/dispatcher/state.ts` to match. Loader treats absent as `{ state: "pending", startable: null, completed_at: null }`. When editing `src/dispatcher/state.ts`, preserve the existing `Termination` union (`kind: "run_budget" \| "user_interrupt"`, `signal: "SIGINT" \| "SIGTERM" \| null`) added in F6. Do not narrow it back to `"run_budget"` only. | `schemas/state.schema.json`, `src/dispatcher/state.ts` |

#### Dispatcher algorithm changes

| # | Task | Files |
|---|---|---|
| F7.11 | `src/dispatcher/run.ts` — insert probe phase between discovery and the main loop. New algorithm step (inserted between existing steps 1 and 2 in §5.10): <br>1a. **Stale lock cleanup.** Call `appLock.cleanupStale(...)` before `active.json` truncation. <br>1b. **Probe phase.** Guard the entire probe phase behind `!opts.dryRun` — `--dry-run` must not invoke agents (architecture §13.3). If `state.app_probe.state !== "done"`: set `state.app_probe.state = "running"` (atomic write), call `invokeProbe(...)` (which returns `{ probe: AppProbe, pid: number }`), add the returned PID to `inflightSpawns` immediately after spawn resolves (consistent with existing stage-1/stage-2 PID-tracking), remove probe PID from `inflightSpawns` on completion, write `state.app_probe = { state: "done", startable: probe.startable, completed_at: now }` (atomic write). If `state.app_probe.state === "done"`: read `app-probe.json` from dispatcher zone; if the file is missing or fails validation (e.g., manually deleted after a crash), fall back to re-running the probe (treat as `running`) with an INFO log — do not abort. <br>The probe PID is added to the same `inflightSpawns` set used by signal-shutdown (§21 / F6.4) so SIGTERM propagates. | `src/dispatcher/run.ts` |
| F7.12 | `src/stage2/invoke.ts` — accept `appProbe: AppProbe \| null` in opts. Pass `appProbe` to Stage 2 `RunnerInput` (new field `appProbe`). After `tier-validate`: if `appProbe?.startable === false` AND `outcome.tier === 1`, call new `applyAppNotStartableDowngrade(outcome)`. | `src/stage2/invoke.ts` |
| F7.13 | `src/stage2/tier-validate.ts` — add `applyAppNotStartableDowngrade(outcome: Outcome): Outcome`. If `tier === 1`: set `tier = 2`, `tier_claim` unchanged, `downgrade_reason = "app_not_startable"`, `exploit_targets_application = false`, re-clamp confidence. | `src/stage2/tier-validate.ts` |
| F7.14 | `src/stage2/prompt.ts` — update Stage 2 system prompt to include the app-probe result section. When `startable: true`: include `start_commands`, `stop_commands`, `port`, `health_check_url`, `startup_timeout_seconds`, and instructions to call `AcquireAppLock` before starting the application and `ReleaseAppLock` after stopping it. When `startable: false`: state that live-application verification is unavailable for this run and Tier 1 is not possible; instruct agent to focus on Tier 2. | `src/stage2/prompt.ts` |

#### active.json telemetry change

| # | Task | Files |
|---|---|---|
| F7.15 | Extend `ActiveAgent` in `src/dispatcher/telemetry.ts`: change `stage: 1 \| 2` to `stage: 1 \| 2 \| "probe"` and `target_file: string` to `target_file: string \| null`. The probe's telemetry entry is constructed with `stage: "probe"` and `target_file: null`. No JSON schema file exists for `active.json`; no schema file update is needed. Do not modify `schemas/state.schema.json` for this change. Any callers that construct `ActiveAgent` objects for stage-1/stage-2 agents (the existing path) pass non-null values and are unaffected. | `src/dispatcher/telemetry.ts` |

#### Filesystem layout addition

Per §4 (per-run filesystem layout), add the probe subtree:

```
<repo>/.lbvd/<run-id>/
├── app-probe.json               ← dispatcher zone; immutable once written
├── app-access.lock              ← filesystem mutex; present only while held
├── probe/
│   ├── app-probe.json           ← probe agent's intermediate output
│   ├── probe.transcript         ← probe agent's redacted transcript
│   └── probe.log                ← probe agent's structured log
```

#### Manifest changes

| # | Task | Files |
|---|---|---|
| F7.16 | `src/manifest/build.ts` — after building per-target outcomes, attempt to read `<runDir>/app-probe.json`. If present and valid: add `app_probe: { startable, probe_narrative, probe_wall_seconds }` to the manifest. If absent or malformed: add `app_probe: null`. Update `Manifest` TypeScript type to include this field. | `src/manifest/build.ts` |
| F7.17 | `src/manifest/render-md.ts` — render the `app_probe` field as a "Application Startup" section in the markdown manifest. When `null`: render "Probe did not complete." When `startable: true`: render "✓ Application startable — <narrative> (<wall_seconds>s)." When `startable: false`: render "✗ Application not startable — <narrative>." | `src/manifest/render-md.ts` |

#### Schema for `app-probe.json`

```ts
{
  schema_version: 1,
  startable: boolean,
  start_commands: string[],         // non-empty; validated by dispatcher before passing to Stage 2
  stop_commands: string[],          // non-empty
  port: number | null,              // primary TCP port the app listens on
  health_check_url: string | null,  // HTTP URL for reachability check
  startup_timeout_seconds: number,  // how long to wait for app to become reachable
  pre_conditions: string[],         // documented env vars or prerequisites
  probe_narrative: string,          // human-readable summary of what was tried and why
  tried: boolean,                   // whether start was actually attempted
  successfully_started: boolean,    // whether reachability check passed
  failure_reason: string | null,    // "probe_wall_clock_cap" | free text | null
  probe_token_usage: { input: number, output: number },
  probe_wall_seconds: number
}
```

#### Fixture corpus additions

| # | Task | Files |
|---|---|---|
| F7.18 | Add probe fixture scenarios under `tests/fixtures/canned-agents/`: <br>• `probe-startable/probe/app-probe.json` — `startable: true`, real commands, port 3000 <br>• `probe-not-startable/probe/app-probe.json` — `startable: false`, failure_reason "no startup artefacts found" | `tests/fixtures/canned-agents/probe-startable/`, `tests/fixtures/canned-agents/probe-not-startable/` |

#### Tests

| # | Task | Files |
|---|---|---|
| F7.19 | Workflow test: `startable: true` path. Fixture scenario `probe-startable` + Stage 2 fixture with `tier_claim: 1, exploit_targets_application: true`. Assert: `app-probe.json` exists with `startable: true`; manifest `app_probe.startable = true`; outcome tier is 1 (not downgraded). | `tests/workflow/app-probe.test.ts` |
| F7.20 | Workflow test: `startable: false` path. Fixture scenario `probe-not-startable` + Stage 2 fixture with `tier_claim: 1`. Assert: manifest `app_probe.startable = false`; outcome tier is 2 (downgraded by `app_not_startable` rule); `downgrade_reason = "app_not_startable"`. | `tests/workflow/app-probe.test.ts` |
| F7.21 | Workflow test: probe budget kill. Fake a probe budget of 0 s (or inject a clock that immediately fires). Assert: `app-probe.json` has `startable: false, failure_reason: "probe_wall_clock_cap"`; run continues; Stage 2 outcomes are Tier 2 at most. | `tests/workflow/app-probe.test.ts` |
| F7.22 | Workflow test: resume after probe crash. Set probe state to `running` in a pre-seeded `state.json`; call `resume`. Assert: probe re-runs (fixture runner invokes `spawnProbe`); probe reaches `done`. | `tests/workflow/app-probe.test.ts` |
| F7.23 | Workflow test: resume after probe done. Set probe state to `done` in a pre-seeded `state.json` with `app-probe.json` present. Call `resume`. Assert: `spawnProbe` is NOT called (probe is reused). | `tests/workflow/app-probe.test.ts` |
| F7.24 | Unit test: `AppLock.acquire` — second caller blocks until first releases. Two in-process `makeAppLock` instances sharing the same lock path; assert sequential behaviour via timing. NOTE: this test is an in-process approximation — it verifies the polling and back-off logic but cannot observe O_CREAT\|O_EXCL atomicity across separate OS processes. The mutex's cross-process correctness is covered by the FR-17.3 workflow acceptance criterion (F7.19). | `tests/unit/app-lock.test.ts` |
| F7.25 | Unit test: `AppLock.cleanupStale` — stale lock (age > threshold, PID dead) is removed. Mock `kill(pid, 0)` to return ESRCH; seed a lock file with an old `locked_at`; assert file is deleted. | `tests/unit/app-lock.test.ts` |
| F7.26 | Unit test: `applyAppNotStartableDowngrade` — verify Tier 1 → Tier 2 with correct downgrade reason; verify Tier 2 and Tier 3 unchanged. | `tests/unit/tier-validate.test.ts` |
| F7.27 | Manifest contract test: `app_probe: null` when no `app-probe.json` present in run dir; `app_probe` with fields when file present and valid. | `tests/unit/manifest-app-probe.test.ts` |

**Task dependencies:**
- F7.1 before F7.2, F7.3 (schema compiled by validator)
- F7.5 before F7.6, F7.7 — TypeScript will not compile after F7.5 until both runner implementations are updated; F7.6 and F7.7 must land in the same changeset as F7.5
- F7.10 before F7.11 (state schema before dispatcher reads it)
- F7.4 before F7.8, F7.11 (lock module before its users)
- F7.8 before F7.6 (agent-host tools before sdk-runner calls agent-host with probe input)
- F7.12, F7.13, F7.14 after F7.1 (App-probe type available)
- F7.16, F7.17 after F7.1 (app-probe schema)
- F7.18 before F7.19–F7.23 (fixtures before tests)
- F7.9 before F7.11 (config defaults before dispatcher)

**Complexity notes:**
- `invokeProbe` in `src/probe/invoke.ts`: budget timer + agent spawn + file validate + dispatcher-zone write — split into at least `runProbeAgent` and `readAndValidateProbeOutput` helpers to stay under the ≤10 limit.
- `src/app-lock/lock.ts` `acquire`: back-off loop + staleness check — extract `checkStaleness` as a helper.
- `agent-host.ts` gains two new tools. If the total `canUseTool` dispatch grows past 10 cases, extract the tool-dispatch into a `dispatchTool` helper indexed by tool name.
- `run.ts` probe phase: insert as a single `runProbePhase(...)` helper call to keep `run()`'s main body under budget.

**Hard constraint additions for §10:**
- No `fs.openSync` or `fs.open` with `O_CREAT | O_EXCL` outside `src/app-lock/lock.ts`.
- No direct reads from or writes to `<runDir>/app-access.lock` outside `src/app-lock/lock.ts`. `AcquireAppLock` / `ReleaseAppLock` in `agent-host.ts` must call through the `AppLock` interface; no direct file open.
- Write-owner for dispatcher-zone `<runDir>/app-probe.json`: `src/probe/invoke.ts` only. Permitted readers: `src/dispatcher/run.ts` and `src/manifest/build.ts` only. The probe agent writes only to `<runDir>/probe/app-probe.json`.

---

## 10. Hard constraints (do not violate)

These are CI-enforceable and apply to every phase.

- Cyclomatic and cognitive complexity ≤ 10 per function (CLAUDE.md). Flat
  dispatch over closed sets exempt for cyclomatic.
- No `Date.now()` / `new Date()` / `process.hrtime` outside `src/clock/`.
- No forge SDK or forge-bound HTTP request constructed outside `src/reporter/`.
- No log emit outside `src/log/log.ts`.
- No write to a file shared across pipelines outside `src/dispatcher/`.
  Per-target files are written by the agent subprocess; `state.json`,
  `active.json`, manifest files, run-level logs, and the local-report subtree
  are dispatcher-only.
- No bypass of `src/redaction/` for any text bound for stdout, log file, or
  transcript file.
- No `console.log` / `console.error` in `src/` (except `cli.ts` for help/usage).
- No direct `process.env.ANTHROPIC_API_KEY`, `process.env.ANTHROPIC_AUTH_TOKEN`,
  or `process.env.CLAUDE_CODE_OAUTH_TOKEN` reads outside `src/config/load.ts`
  (the auth-credential resolver), `src/runner/safe-env.ts` (the env-passthrough
  chokepoint), and `src/cli.ts` (the resolver call site; pre-`Logger` startup
  path). The auth-mode gate (architecture §20.2) is meaningless if other
  modules can read these env vars directly. Note: `apiKeyHelper`, when
  configured by the operator, runs *inside* the agent subprocess after
  env-passthrough; the chokepoint cannot see helper-injected credentials. This
  is an operator-environment hazard documented in the README runbook (FR-15
  out-of-scope), not enforced in code.

- No `fs.openSync` or `fs.open` with `O_CREAT | O_EXCL` outside `src/app-lock/lock.ts` (the filesystem mutex implementation). Any other atomic file creation is a regression of the single-writer discipline.
- No direct reads from or writes to `<runDir>/app-access.lock` outside `src/app-lock/lock.ts`. `AcquireAppLock` and `ReleaseAppLock` tools in `agent-host.ts` must call through the `AppLock` interface (F7.4); they must not open the lock file directly.
- **Write-owner for dispatcher-zone `<runDir>/app-probe.json`:** `src/probe/invoke.ts` only. No other module may write this file.
- **Permitted readers of dispatcher-zone `<runDir>/app-probe.json`:** `src/dispatcher/run.ts` and `src/manifest/build.ts` only.
- The probe agent writes only to `<runDir>/probe/app-probe.json` (the probe subtree); it never writes to the dispatcher-zone path directly.

CI lints these in addition to TypeScript strict-mode checks.

---

## 11. Post-MVP backlog

Shapes are preserved in the schemas / interfaces; only the call sites are
gated. Each item is one-flag work to enable when prioritized.

- **Cross-run dedup at initial open** — the dispatcher does not call
  `findIssueByMarker` before opening a new finding-issue. Resume reconciliation
  still uses it (FR-12 idempotency). To enable: flip the open-path gate in
  `dispatcher/pipeline.ts:reportPhase`.
- **"Previously reported (closed)" linking** — closed-issue branch in the
  pipeline currently treats `closed` as "no match"; flip to "file new + link"
  to enable.
- **"Also affects" enrichment in issue body** — field omitted from
  `issue-body.ts`; add when within-run dedup ships.
- **Reopen-and-comment for closed issues.**
- **Notifier hook** — reserve `onTerminal(targetState)` on the reporter (no-op
  default). MVP substitute: INFO log lines on every terminal transition.
- **Live progress signal** — no per-agent `status.json` in MVP. The end-of-run
  manifest is the deliverable.
- **Infra-issue dedup-by-fingerprint** — same flag family.
- **`skipped_dup` terminal state** — reserved in the schema, not produced by
  any MVP code path.
- **GitLab reporter** — `selectReporter()` throws when `vcs.provider=gitlab`.
- **GitHub HTTP-replay corpus refresh** — replay/recording transports ship
  with a synth-seeded corpus; refreshing against real GitHub responses
  needs a provisioned fixtures repo (`scripts/setup-fixtures-repo.sh`) +
  fine-grained PAT + a run of `npm run record-http:github`.

---

## 12. Decision log

Numbered architectural decisions live in `architecture.md`. Implementation-level
decisions worth keeping (because they're not derivable from code):

- **Fingerprint normalization.** Strip line and block comments; collapse
  whitespace runs; trim. Language-agnostic. A change to this rule is a
  `schema_version` bump and orphans existing per-target subtrees on resume.
- **Schema source-of-truth direction.** JSON-canonical: `schemas/*.schema.json`
  is the authoring artifact, AJV-compiled at startup. `src/*/schema.ts` reads
  the JSON via `fs` and exposes a typed validator.
- **Default LLM model.** `claude-opus-4-7` for both stages.
  `runner.sdk.model` in config overrides per-run.
- **OS-enforced capability boundary.** Path-prefix validation via
  `confineToParent` (realpath + prefix-check) inside the `canUseTool` shim
  (`src/runner/sdk-tool-shim.ts`). Stage 2's Bash is unconstrained except by
  the `cwd=targetSubtree` binding — the threat model accepts this.
- **Permission mode.** `bypassPermissions` + `allowDangerouslySkipPermissions:
  true` so `canUseTool` is the single source of truth in a non-interactive
  subprocess.
- **`findBranch` URL recovery.** Forge reporters derive the URL
  deterministically from `(repo, branch_name)`; no API round-trip on resume.
- **Substrate marker.** `LBVD_SUBSTRATE=web-sandbox` is exported by the
  slash-command bootstrap. The engine never sniffs Claude-Code-internal env
  vars.
- **`schema_version` bump policy.** Forward-compatible additions don't bump;
  removes / renames / type changes / new required fields do and require a
  CHANGELOG migration note. No automated migration tool until a real bump.
- **Auth-credential redaction by literal value.** `src/cli.ts` (in
  `buildStartup`) captures the selected token string once at startup and
  threads it into `makeRedactor` (`extraLiterals`), which masks the literal
  everywhere downstream (logs, transcripts). Short literals (< 8 chars) are
  dropped silently to avoid masking harmless substrings. Prefix-regex
  patterns for `sk-ant-…` and `oat_…` are kept in `REDACTION_PATTERNS` as
  defense-in-depth for paths that miss the literal mask (architecture §15.4,
  §20.2).
- **Mode-gated SDK-auth allowlist.** `safe-env.ts` extends the existing
  unconditional allowlist with a per-`auth.mode` filter for the Anthropic
  credential subset (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN`). `ANTHROPIC_AUTH_TOKEN` is dropped in *both* v1
  modes — the v1 enumeration only models the two end-user paths (Console key
  vs. subscription OAuth); custom-auth-token / gateway-proxy use is not a v1
  use case. Operators previously relying on `ANTHROPIC_AUTH_TOKEN` must move
  to `auth.mode: api_key` or wait for a future custom-token mode. README
  runbook calls this out. Bedrock/Vertex/AWS/GCP env vars are forwarded
  unchanged in v1 — a future `bedrock`/`vertex` mode would graduate them
  (decision 24).
- **Signal shutdown: `setupSignalHandlers` extracted for complexity budget.** The `runPipelineLoop` function is already at non-trivial cognitive complexity. The signal handler setup (register, deregister-first, set flags, call abort) is extracted into `setupSignalHandlers` as a named function that returns a query interface (`killed()`, `signal()`, `cleanup()`). This keeps `runPipelineLoop` under the CLAUDE.md ≤10 complexity budget while keeping the signal-path code in the same file as the budget-kill path (architecture §21.1).
- **`clearTimeout` + `signalShutdown.cleanup()` in the same `finally` block.** Both the budget timer clear and the signal-listener deregistration are moved into a shared `finally` around `await Promise.all([...inflight])`. This ensures listener cleanup and timer cancellation fire on every exit path, including unexpected throws (implementation review R2).
- **`AppLock.acquire` staleness threshold = `stage2BudgetMs + mutexTimeoutMs`.** A live lock-holder may have waited up to `mutexTimeoutMs` before acquiring, so age ≤ `stage2BudgetMs + mutexTimeoutMs` cannot be declared stale even if the PID appears dead (PID reuse). The combined threshold is the minimum safe window. See architecture §22.4.
- **Probe's intermediate output path = `<probeSubtree>/app-probe.json` (convention, not a field).** The dispatcher derives the path from `probeSubtree`; the probe agent is told to write there by the agent-host (which is constructed with `probeSubtree` as its write zone). This removes a variable parameter from `ProbeRunnerInput` (architecture §22.11).
- **`AcquireAppLock` / `ReleaseAppLock` as agent-host tools, not Bash wrappers.** The mutex acquisition uses O_CREAT\|O_EXCL with polling — not expressible in a single shell command without a race. Implementing it as a Node.js agent-host tool ensures atomicity and proper back-off without shell complexity.
