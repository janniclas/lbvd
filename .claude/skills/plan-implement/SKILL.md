---
name: plan-implement
description: Use whenever an operator or developer asks Claude to implement, build, code up, land, or ship a feature that already has closed plan docs in this SPHA CRA repo — i.e. `docs/plans/{requirements,architecture,implementation}.md` carry the FR and two `docs/plans/plan-review-*` files closed APPROVE. Picks up at step 8 of `docs/plans/agent-guide.md`: codes the change per `implementation.md`, runs the side-appropriate verification block, then **always** invokes `post-implementation-reviewer` (and `security-review` whenever the change touches a `CLAUDE.md` "Security rules" item), auto-applies must-fix findings, escalates blockers to the operator, and re-challenges the result against `requirements.md` + `architecture.md` (rerunning the reviewers if material code changes land). Trigger eagerly on phrases like "implement FR-…", "let's build it", "start coding", "land this feature", "code up the plan", "execute the implementation plan", "ship it", "make it real". Do not trigger when no plan has been written yet — that's `plan-doc-extend`.
---

# Plan-implement

This is the second half of the `agent-guide.md` workflow. `plan-doc-extend` runs steps 1–7 and leaves three closed plan docs plus two `plan-review-*` files. This skill takes that artefact and executes the rest: code, mandatory verification, two post-implementation review agents, triage of their findings, and a final challenge of the code against the spec. The reviewer agents are not optional polish — they are how the project catches the recurring failure modes (security regressions, complexity drift, architectural breaks) that don't surface in build + test.

## When to use vs. when to skip

**Use** when the plan is closed and you're about to write code for a non-trivial change: a new FR, a new module, a cross-module refactor, a new config surface, a new route or migration.

**Skip** for the same trivial edits that skip `plan-doc-extend`: typo, rename inside one file, one-line bug fix, comment-only edit, formatting. These go straight to code and the side-appropriate verification block. No reviewer agents required, no plan docs touched.

**Redirect** to `plan-doc-extend` if the user asks you to implement something whose plan isn't closed (no FR, no `plan-review-*` files, or the review files don't end in APPROVE / REFINE-with-fixes-applied). Implementing against an open spec is how wiring-order and migration bugs leak into code — the two-pass review exists exactly to keep that from happening.

## The workflow (six phases)

These extend `agent-guide.md` step 8. Run them in order; the loop at phases 4–6 may iterate.

### 1. Preflight — verify the plan is closed

Before touching code, confirm:

- `docs/plans/requirements.md` carries the FR (or no FR if architectural-only).
- `docs/plans/architecture.md` carries the new section / decision-log entry, if applicable.
- `docs/plans/implementation.md` has the phase row with `F<N>.x` tasks: file paths, function signatures (where stable), and test-column references to `docs/testing-strategy.md` layers.
- Two `docs/reviews/plan-review-YYYY-MM-DD-<slug>-*.md` files exist for this change (spec + impl), both closed APPROVE or REFINE-with-fixes-applied.

If anything is missing, **stop and tell the operator** to run `plan-doc-extend` first. Don't paper over a gap by re-deriving spec from the user's request mid-flight — that loses the two-pass review.

### 2. Implement — code from `implementation.md`

Treat `implementation.md` as the work order. For each `F<N>.x` task:

- **Edit existing module sections** (`config` → `repository` → `service` → `handler`, plus `dtclient` / `netguard` etc.). Don't invent a new top-level module unless the plan says so.
- **Follow the file paths and signatures the plan pins.** If reality forces a deviation (a function signature the plan hadn't seen, a missing utility), make the smallest deviation that works, then *record it* in `implementation.md`'s "Resolved during build" subsection — that's where in-flight decisions land, not in the decision log.
- **Honour the complexity budget.** Both cyclomatic and cognitive complexity ≤ 10 per function. If an edit pushes a function over, split as part of the same change. Indicators you've crossed the line before measuring: >50 lines, >3 nesting levels, a comment explaining "what this block does."
- **Honour the security rules** (`CLAUDE.md` "Security rules"). Every new outbound DT call flows through `netguard.ValidateExternalURL`; every new API-key field is AES-GCM-encrypted at rest and redacted on read paths; no body / header / query logging in `middleware.Logger`; `/admin/*` stays unauth-by-design (flag changes to the operator).
- **Write tests as you go**, against the layers in `docs/testing-strategy.md`. The implementation.md test column tells you which layer (Go unit, Go integration, Vitest unit, Vitest component). Don't redefine harnesses inline.
- **README sync** if the change touches a user-visible surface (env var, route, command, setup, operating mode, DT query type, API envelope). Don't defer this — it's part of "done."

### 3. Mandatory verification — run the side-appropriate block

From `CLAUDE.md` "Mandatory verification after changes." Run only the block that matches the side you changed:

- **`ui/` changes**: `(cd ui && npm run build)` then `(cd ui && npm test)`.
- **`server/` changes**: `(cd server && gofmt -w .)` then `(cd server && go build ./cmd/server)` then `(cd server && go test ./...)`.
- **Both sides**: run both blocks.
- **Config-only edits**: no build/test needed.

If a check fails, fix it before invoking the reviewers — they're not for catching build breaks. If the failure is a test you can't pass without a real database, surface it to the operator (`docs/testing-strategy.md` "Hard constraints" forbids testcontainers; the user has confirmed this preference).

### 4. Post-implementation reviews

**`post-implementation-reviewer` always runs.** It writes to `docs/reviews/review-YYYY-MM-DD-<slug>.md` and covers quality, correctness, complexity-budget breaches, and architectural breaks. Every implementation pass goes through it — no exceptions.

**`security-review` runs when the diff touches any `CLAUDE.md` "Security rules" item**, which is the same gate that `plan-doc-extend` uses. The check is mechanical: walk the diff and ask whether it touches any of:

- outbound HTTP to a user-supplied URL (DT integration, deep-link fetcher, any new `dtclient` path)
- AES-GCM crypto or `ENCRYPTION_KEY` handling
- `/admin/*` surface (new route, new handler, expanded behaviour)
- SPA static-file serving or path-traversal logic
- request logging (`middleware.Logger`)
- the `/api/*` JSON envelope / 404 path
- new deserialization or sinks reached by untrusted input
- any secret handling (new credential type, new persistence path for an existing one)

If the answer is "yes" to any of those, invoke `security-review`. If not, skip it — running it on a pure-UI refactor or an internal-tooling change burns tokens for findings that won't materialize. When in doubt, run it.

When you run `security-review`, it writes to `docs/reviews/sec-review-YYYY-MM-DD-<slug>.md` and covers SSRF / netguard, AES-GCM / `ENCRYPTION_KEY`, `/admin/*`, SPA static-file serving, logging, the API envelope, untrusted input reaching DOM sinks.

If both reviewers are running, issue them in the same turn as two parallel `Agent` calls. Pass each one the same prompt skeleton (see "Invoking reviewers correctly" below). The `<slug>` should match the FR / feature slug used in the plan-review filenames so the review trail is greppable.

### 5. Triage findings — auto-fix must-fixes, escalate blockers

Each reviewer returns findings. Sort them into two buckets:

| Bucket | What it looks like | Action |
|---|---|---|
| **Must-fix** | Bug in the diff; missed redaction; missing netguard call; complexity over budget; missing test against a `testing-strategy.md` row; missing README / `.env.example` sync; broken acceptance criterion | **Apply automatically.** These are mechanical fixes that match what the plan / spec already says. |
| **Blocking** | Requires a decision the spec didn't make; reveals a contradiction in `requirements.md` or `architecture.md`; expands the `/admin/*` surface; introduces a new trust boundary or secret type; asks for an architectural change | **Stop and surface to the operator.** Quote the finding, name the decision needed, propose 1–2 options. Do not guess — guessing turns into "behavioural change phrased as additive" rot. |

A finding flagged ESCALATE by either reviewer is always blocking by definition. A finding flagged REFINE with a concrete diff is must-fix; apply the diff and move on.

After applying must-fixes, **re-run the mandatory verification block** from phase 3. Don't trust a green build from before the fixes.

### 6. Re-challenge against requirements + architecture

After the reviewers have closed and their must-fixes are applied, do a final pass yourself: read `requirements.md` for this FR (Behaviours + Acceptance criteria) and `architecture.md` for the relevant invariants, and walk through the code to confirm each acceptance bullet has a corresponding test row and each invariant is upheld. The reviewers catch *code-level* breaks; this pass catches *spec-level* drift — the implementation that builds clean but doesn't actually deliver the FR's contract.

Three outcomes:

1. **Match.** Every acceptance criterion has a passing test; every invariant holds. Move to "done."
2. **Small drift in code.** Code disagrees with spec but the spec is still right (e.g. a behaviour wired wrong, a missing default, a test that asserts outputs instead of invariants). Apply the fix, **rerun phase 3**, and if the diff is non-trivial **rerun phase 4** — a fresh material code change deserves a fresh review. Then loop back to 6.
3. **Spec needs to change.** Implementation revealed a gap in `requirements.md` or `architecture.md`: an acceptance criterion is unachievable as written, an invariant conflicts with reality, a new decision is needed. **Stop. Hand back to `plan-doc-extend`** with the gap described. Don't rewrite the plan docs from inside this skill — that bypasses the two-pass review and is exactly the failure mode the workflow exists to prevent.

The loop terminates when phase 6 returns "Match" *or* when an escalation to the operator unblocks (case 3 redirects out; cases 1 and 2 stay inside).

## Invoking reviewers correctly

Each reviewer is one `Agent` call. The prompt should give it:

1. **Subject.** The exact files and packages changed — paths, not "the diff." Reviewers read selectively; precise pointers save a re-grep of the whole repo.
2. **Diff context.** A `git diff` against the merge base, or the list of changed files plus the relevant `git log`. The reviewer cannot guess what you changed.
3. **Standing preferences from the user.** Restate the relevant items from this session's memory each call — the reviewer is stateless. Especially:
   - "No testcontainers / real-DB integration tests in this dev container."
   - Any feature-specific decisions the operator has already signed off on.
4. **The plan docs and review files for this change.** Paths to `requirements.md`, `architecture.md`, the relevant `implementation.md` phase row, and the two `plan-review-*` files. The reviewer needs the spec it's reviewing against.
5. **Output destination.** Pin the filename: `docs/reviews/review-YYYY-MM-DD-<slug>.md` for `post-implementation-reviewer`, `docs/reviews/sec-review-YYYY-MM-DD-<slug>.md` for `security-review`. Both agents have Write access; let them write directly.

When a reviewer returns **APPROVE**, move on. When it returns **REFINE**, treat its concrete diffs as must-fixes and apply them. When it returns **ESCALATE**, surface the question to the operator immediately — don't guess.

## Standing rules

- **Review files are temporary** (per `CLAUDE.md` "Review documents are temporary"). Apply the must-fixes back into the code; never cite a `review-*.md` from `CLAUDE.md`, `README.md`, or the three plan files. They will age out.
- **`docs/testing-strategy.md` is canonical.** Implementation tests reference its layers (§3.1 row 'X', §4.2 fake HTTP server), never redefine harnesses. The acceptance criteria from `requirements.md` should map 1:1 to rows in §3 — if a criterion has no test row, that's a phase-6 finding, not a green light.
- **Append, don't renumber.** If implementation reveals a new decision worth keeping, append to the `architecture.md` decision log or the `implementation.md` "Resolved during build" subsection. Do not renumber existing FRs or sections — cross-references break silently.
- **Complexity budget is non-negotiable.** Cyclomatic + cognitive ≤ 10. If a reviewer flags a breach, splitting the function is a must-fix, not a stylistic suggestion.
- **README sync is part of done.** A user-visible surface change (env var, route, setup command, DT query type, API envelope shape) gets a `README.md` edit in the same PR. Don't ship without it.

## What "done" looks like

The plan-implement workflow closes when:

- All `F<N>.x` tasks in the relevant `implementation.md` phase are coded and have tests at the layer their test column references.
- The mandatory verification block for the side(s) touched passes clean.
- `docs/reviews/review-YYYY-MM-DD-<slug>.md` exists and closes APPROVE (or REFINE-with-fixes-applied).
- `docs/reviews/sec-review-YYYY-MM-DD-<slug>.md` exists and closes APPROVE (or REFINE-with-fixes-applied).
- The phase-6 re-challenge returns "Match" — every acceptance criterion has a passing test, every relevant architectural invariant holds.
- `README.md` is in sync if a user-visible surface changed.
- No blocking escalation is outstanding; if one was raised, the operator has resolved it.

Only then is the feature shipped. If any item above is unchecked, the feature is half-landed, not done — say so explicitly to the operator rather than reporting success.
