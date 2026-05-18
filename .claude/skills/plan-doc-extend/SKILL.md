---
name: plan-doc-extend
description: Use whenever an operator or developer asks for a new functional requirement, a new architectural section, a cross-module refactor, a new config surface, or any non-trivial feature change in this SPHA CRA repo — anything that would land code touching more than one module. Drives the canonical workflow in docs/plans/agent-guide.md (`requirements.md` → `architecture.md` → spec-pass review → `implementation.md` → impl-pass review → apply review fixes → only then code). Trigger eagerly on phrases like "add FR-…", "new requirement", "let's extend the plan", "new feature", "refactor X across modules", "add an env var / route / migration", "spec out", "design", "let me write up Y". Do not trigger for typos, renames, one-line bug fixes, or comment changes.
---

# Plan-doc extend

This repo owns three append-only plan docs that are the single source of truth: `docs/plans/{requirements,architecture,implementation}.md`. Every non-trivial change updates them in the same PR, gated by two passes of the `plan-reviewer-architect` agent. The procedural rules and failure modes live in `docs/plans/agent-guide.md` — read it before editing the plans, and follow it; this skill is the scaffolding that makes sure the gates fire in the right order.

## When to use vs. when to skip

**Use** for: a new FR, a new architectural section, a new module, a cross-module refactor, a new config knob / env var / route / migration, anything that would touch ≥ 2 modules, or any feature request beyond a one-liner.

**Skip** for: typo, rename inside one file, one-line bug fix, comment-only edit, formatting, doc-only edit that doesn't change behaviour. These go straight to code per `agent-guide.md` §0.

If you're unsure which side of the line, default to "use." A 60-second skim of `agent-guide.md` is much cheaper than a wiring-order bug found in code review.

## The workflow (the eight steps)

`agent-guide.md` §1 is authoritative. The summary below is so you can keep the order straight without re-reading it every time; the rationale and the failure modes still live there.

1. **Verify feasibility first.** If the request depends on an external system (DT / DefectDojo API, third-party library), read the authoritative docs before drafting. Cost of a wrong "infeasible" = a missing feature; cost of a wrong "feasible" = a doomed plan.
2. **Edit `requirements.md`** — the *what*. Append the FR (Description / Behaviours / Acceptance, plus Out-of-scope if a trade-off needs surfacing). Add a row to the feature → requirement table. Cross-link related FRs. **Append-only; do not renumber existing items.**
3. **Edit `architecture.md`** — the *how-concept*. New top-level section appends before the Decision log; new decisions append. Touch existing sections only when their invariants actually change.
4. **Spec pass — invoke `plan-reviewer-architect`** on the requirements + architecture diff. Save its output to `docs/reviews/plan-review-YYYY-MM-DD-<slug>-{requirements,architecture}.md` (one file per doc reviewed, or one combined file with a clear heading split — match the recent FR-16 precedent). Apply must-fixes back into the plan docs. Surface ESCALATE items to the user. **Critical:** pass the user's standing preferences (memory entries, "no testcontainers" rule, prior project decisions) explicitly in your invocation — the reviewer doesn't see your memory.
5. **Edit `implementation.md`** — the *how-concrete*. Thread the new behaviour through the existing module sections (`config` → `repository` → `service` → `handler`, plus `dtclient` / `netguard` etc. when relevant); append a phase row with `F<N>.x` tasks (file paths, function signatures, test column). Don't create a new top-level section for one feature unless it really is a new module.
6. **Implementation pass — invoke `plan-reviewer-architect` again** on the implementation diff with a **separate** review file: `docs/reviews/plan-review-YYYY-MM-DD-<slug>-implementation.md`. Spec pass asks "is this the right design?"; impl pass asks "does the plan faithfully derive from the spec?" The two-pass split is load-bearing — skipping pass 2 lets wiring-order, migration, and unstated-default bugs leak into code. Apply must-fixes; escalate ESCALATEs.
7. **Apply review feedback, then write code.** Must-fix items are not optional. After the impl review closes, run the side-appropriate verification block from `CLAUDE.md` ("Mandatory verification after changes").
8. **Post-implementation reviews.** After the change lands, invoke `post-implementation-reviewer`. If the change touches any `CLAUDE.md` "Security rules" item (outbound HTTP, `ENCRYPTION_KEY`, `/admin/*`, SPA static-file serving, netguard, request logging), also invoke `security-review`. Both write to `docs/reviews/{review,sec-review}-YYYY-MM-DD-<slug>.md`.

## Standing rules (don't forget these)

- **Append, don't renumber.** New FRs, new architecture sections, new decision-log entries always go at the end of their sequence. Subsections inside an existing section may insert anywhere, but renumber downstream and re-grep cross-doc references when you do.
- **Spec / arch / impl boundary** (`agent-guide.md` §2 has the litmus test + examples). If a value's change would change observable behaviour under a valid config → requirements. If it's an invariant or contract that constrains every implementation → architecture. If it's a robustness tunable, lock key, or freely-picked name → implementation. **When in doubt, push it down.** Over-spec creates churn; under-spec creates ambiguity.
- **Review files are temporary.** Per `CLAUDE.md` "Review documents are temporary": fold must-fixes back into the canonical doc; never cite a review file from a main doc.
- **`docs/testing-strategy.md` is canonical.** `implementation.md` test inventories reference its layers (e.g. "§3.1 row 'X'", "§4.2 fake HTTP server"), not redefine harnesses inline.
- **Prune as you go** (`agent-guide.md` §5). Stale "deferred / post-MVP" entries that shipped collapse to a one-line "done" or get deleted. Duplicate explanations across docs pick one canonical home and cross-reference from the other.
- **README sync.** If the change alters a user-visible surface (env var, route, command, setup, operating mode, DT query type, API envelope), update `README.md` in the same change. Pure refactors don't need it.

## Invoking the reviewer correctly

Each pass is one `Agent` call with `subagent_type: plan-reviewer-architect`. The prompt should give the reviewer:

1. **Subject.** The exact file(s) and section(s) edited — paths and section numbers, not "the requirements." The reviewer reads selectively; precise pointers save it from re-reading the whole doc.
2. **Diff context.** Either a `git diff` of the doc, or quoted before/after for the changed sections. The reviewer cannot guess what you changed.
3. **Standing preferences from the user.** The reviewer is stateless across conversations. Restate the relevant items from this session's memory (e.g. "the user does not want testcontainers / real-DB integration tests"; "the user prefers one bundled PR over splits for refactors in area X"; prior decisions on the FR family). Without this, the reviewer will demand patterns the user has already rejected.
4. **The pass you want.** "Spec pass — review requirements + architecture against the user's request and against `CLAUDE.md` / `agent-guide.md` rules" vs. "Implementation pass — review whether the implementation plan faithfully derives from the now-closed spec + architecture."
5. **Output destination.** Pin the exact filename (`docs/reviews/plan-review-YYYY-MM-DD-<slug>-{requirements,architecture,implementation}.md`). The agent has Write access; let it write the review directly.

When the review comes back **REFINE**, treat its concrete diffs as must-fixes — apply them. When it comes back **ESCALATE**, surface its questions to the user before continuing; don't guess.

## Common failure modes (`agent-guide.md` §4 is the canonical list)

Keep these in mind while drafting — they're the ones the reviewer catches most often. Catching them yourself before invoking the reviewer is faster than going through a REFINE cycle:

1. **Wiring-order contradictions** — the plan says X is registered before Y is constructed, but `main.go` builds Y first. Fix: pin the actual call site (file + line) when in doubt.
2. **Migration / read-path gaps** — new column added, read path expects it, pre-feature rows don't have it. Fix: explicit "if absent, default to <value>" plus a backfill or a unit test that proves NULL tolerance. Doubly important when extending a wide `SELECT … FROM data_sources` style read.
3. **Behavioural changes phrased as additive** — "extend the allowlist with X" when in fact existing entries are now gated by a new criterion, or "add a `kind` field" when in fact every row's wire shape changes. Fix: say "behavioural change" explicitly; enumerate before/after.
4. **Unnamed env vars / config keys / defaults.** Pin every name, every default, plus the `.env.example` and README "Configuration" table updates in the same PR.
5. **Bypassed security chokepoints** — new outbound path that skips `netguard`, new key read that returns plaintext, new `/admin/*` route without flagging the unauth-by-design posture. Fix: enumerate every entry point that should trigger the check; cross-link `CLAUDE.md` "Security rules."
6. **Drop-by-omission.** Listing what's forwarded in a new mode without addressing what previously was forwarded. Fix: explicit before/after table.
7. **Spec-implementation duplication** — same enumeration in both architecture and implementation, prone to drift. Fix: canonical home (usually architecture), reference from the other.
8. **Acceptance criteria that test outputs but not invariants** — "response looks the same" doesn't test a chokepoint. Fix: add a *direct observation* acceptance (assert the netguard validator was hit; assert the fake HTTP server recorded zero requests).
9. **Missing redaction / hygiene coverage for new secrets** — every new credential triggers a sweep of the AES-GCM read-path redact, the `middleware.Logger` allowlist, and `.env.example`.
10. **Renumbering existing items.** Always append. Re-stating because it's the most common silent break.

## Recent precedent

The FR-16 / FR-17 review files in `docs/reviews/` (dated 2026-05-13) are the strongest recent example of the two-pass shape — one file each for the requirements and architecture spec pass, one for the implementation pass. Match their structure (Intent summary → Findings by category → Disposition → Concrete diff). Don't cite them from the main docs; they will age out.

## What "done" looks like

The plan-doc-extend workflow is closed when, for one change:

- `requirements.md` carries the new FR (or no FR if the change is purely architectural).
- `architecture.md` carries the new section / decision-log entry (or no change if the seam is unaffected).
- `implementation.md` carries the file paths, signatures, migration row, and test inventory rows.
- Two `docs/reviews/plan-review-*.md` files exist for this change (spec + impl) and both close with APPROVE or REFINE-with-must-fixes-applied.
- `README.md` is in sync if user-visible surface changed.
- Only **then** does code start — and the post-implementation + security reviews follow after the code lands.
