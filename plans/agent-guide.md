# Agent guide — extending the plan documents

How an AI agent should extend `requirements.md`, `architecture.md`, and
`implementation.md` for a new feature, requirement change, or refinement. The
three-document split itself is described in `CLAUDE.md`; this file covers the
*process* and the recurring failure modes.

If your task is a trivial edit (typo, rename, one-line clarification) you can
skip this guide. It's aimed at non-trivial changes: a new requirement, a new
config surface, a new module, a refactor that crosses module boundaries, or
any change a reviewer would call "scope-bearing."

---

## 1. Workflow for a non-trivial change

The default sequence:

1. **Verify feasibility first.** If the request depends on an external system
   (SDK behavior, forge API, third-party tool), read authoritative docs and
   confirm the capability exists *before* writing a requirement. Push back on
   first-take negatives — search dependent docs, GitHub Action repos, demo
   repos. The cost of a wrong "infeasible" is a missing feature; the cost of a
   wrong "feasible" is a doomed plan.
2. **Add to `requirements.md`** — the *what*. New FRs append (don't renumber).
   Each FR has Description / Behaviors / Acceptance, plus Out-of-scope if the
   trade-off needs surfacing. Cross-link related FRs.
3. **Add to `architecture.md`** — the *how-concept*. A new top-level section
   appends at the end (before the Decision log). New decision-log entries
   append. Update existing sections only when their invariants change. Avoid
   renumbering existing sections — anchors are cross-referenced.
4. **Spec review pass.** Invoke `plan-reviewer-architect` on the
   requirements + architecture changes. Have it write the review to
   `plans/review-<slug>-YYYY-MM-DD.md` (temporary working artifact — see
   CLAUDE.md "Review documents are temporary"). Apply must-fixes; surface
   ESCALATE items to the user.
5. **Add to `implementation.md`** — the *how-concrete*. Edit the relevant
   module specs to thread the new behavior; add a phase row + a sub-section
   listing the F<N>.x tasks (file paths, signatures, test column). Don't
   create a new top-level section just for one feature — integrate.
6. **Implementation review pass.** Run the reviewer again on the
   implementation-plan diff with a *separate* review file. The two reviews
   answer different questions: spec review asks "is this the right design?";
   implementation review asks "does the plan faithfully derive from the spec?"
7. **Apply review feedback.** Must-fix items are not optional; ESCALATE items
   go to the user. Nice-to-have items are judgment calls.
8. **Then code.** Not before.

The two-review pattern is load-bearing. Skipping the implementation-plan
review usually surfaces three classes of bug the implementer would otherwise
hit: wiring-order contradictions, resume/migration gaps, and unstated
defaults. See §5 for the recurring shapes.

---

## 2. Spec-vs-implementation boundary

The same fact can plausibly live in any of the three documents. Heuristics:

| Lives in | When | Examples |
|---|---|---|
| `requirements.md` | User-visible behavior; operator-observable acceptance | "API and subscription auth modes", "scan-changes returns the staged set" |
| `architecture.md` | Invariant or contract that constrains all implementations | "the reporter is the only outbound boundary", "auth chokepoint forwards exactly the selected credential" |
| `implementation.md` | Knobs the implementer chose for robustness or ergonomics | "8-char literal floor for redaction", "branch-name template" |

**Litmus test.** If changing a value would change observable behavior under a
valid config, it's spec. If it's a robustness tunable or a name an implementer
picked freely, it's implementation. When in doubt, push it *down* (toward
implementation) — over-spec creates churn; under-spec creates ambiguity.

A common derivation failure: enumerations or tables that the architecture says
"we forward exactly X" but only the implementation lists *which X*. If the
choice of X is operator-visible (e.g., which env vars survive an auth-mode
switch), the enumeration belongs in architecture. The implementation refers
to it.

---

## 3. Requirements — what good FRs look like

- **One concern per FR.** A new FR is the right tool when the concern has its
  own configuration surface, acceptance criteria, or workflow. Don't fold a
  major concern into FR-9 (config) just to avoid adding a number.
- **Behaviors are testable invariants.** "X aborts at startup" beats "X is
  validated".
- **Acceptance criteria are workflow-test seeds.** A reviewer should be able
  to grep each acceptance bullet to a specific test in
  `implementation.md` §6.<phase>.
- **Out-of-scope sections surface trade-offs.** When a requirement deliberately
  excludes something (ToS enforcement, plan-tier checks, multi-tenant), say so
  in an Out-of-scope subsection. Implicit non-features are scope-drift bait.
- **Don't repeat architectural invariants in FRs.** "The token is redacted"
  belongs in NFR-2 once; FRs say "subject to NFR-2 redaction" and trust the
  cross-link.
- **Workflow → FR mapping table.** When adding an FR, add a row to the
  feature → requirement table in §8.

---

## 4. Architecture — what good sections look like

- **State invariants, not procedures.** "The dispatcher is the single writer
  of state.json" is an invariant. "The dispatcher opens state.json, writes,
  fsyncs, renames" is implementation.
- **Cross-reference principles.** A new section that introduces a new
  boundary should call out which principle (1.3.x) it serves. If it doesn't
  serve one, it may be premature abstraction.
- **Per-section subsections are numbered.** New top-level sections append.
  Subsections inside an existing section may insert anywhere, but the
  numbering must stay sequential.
- **Decision log is append-only.** New decisions get the next number. Never
  renumber existing decisions; cross-references break silently.
- **Resolved-during-build section** captures decisions that crystallized
  during implementation. Drop entries here, not into the main decision log,
  when the implementer settled an open question.

---

## 5. Implementation plan — what good derivations look like

- **Edit existing module specs in §5 rather than appending a new module
  spec.** A new feature usually threads through several existing modules
  (config, dispatcher, runner, redaction). Create a new §5.x only when the
  feature introduces a genuinely new module.
- **Phase rows in §6 capture the work bundle.** Each phase row gets a
  sub-section listing F<N>.<task> rows with file paths and test coverage.
  Mark the dependency graph between tasks.
- **Hard constraints in §10 are CI-enforceable.** If you're adding a "no
  direct read of X outside Y" rule to the architecture, add the lint rule to
  §10 in the same change.
- **Implementation-decision-log entries in §12.** Things future agents
  shouldn't have to re-derive: chosen algorithms, default values, fallback
  behaviors. Each entry is the *why*, not the *what* — the code answers the
  what.
- **Test column is the contract surface.** Per §19 of architecture, tests
  assert against documented contracts only. The test column should say "unit
  on the function's table", "workflow on the FR-<N> acceptance", or similar
  — not "internal state transitions".

---

## 6. Recurring failure modes the reviewer catches

These are the *patterns* the spec/implementation review usually flags:

1. **Wiring-order contradictions.** The plan says "X is threaded into Y before Z
   runs" but the existing call site builds Z before X exists. Fix: pin the
   actual call site (file + line) and update signatures explicitly.
2. **Resume / migration gaps.** New config or state field added; resume path
   reads it; pre-feature snapshots don't have it. Fix: explicit "if absent,
   default to <value>" rule, with a unit test.
3. **Behavioral changes phrased as additive.** "Extend the allowlist with X"
   when in fact the rule is gating the existing entries by a new criterion.
   Fix: say "behavioral change" explicitly and enumerate before/after.
4. **Unnamed env vars / CLI flags / defaults.** "The CLI accepts an override"
   without naming the flag. "The env override exists" without naming the
   variable. Fix: pin every name; the implementer will otherwise invent one.
5. **Substrate / scope-skipped checks.** A new gate added to a code path that
   already has substrate or mode skips. Fix: enumerate every entry point that
   should trigger the new check.
6. **Drop-by-omission.** Listing what's forwarded in a new mode without
   addressing what previously was forwarded. Fix: explicit before/after table.
7. **Spec-implementation duplication.** Same enumeration appearing in both
   architecture and implementation, prone to drift. Fix: pick the canonical
   home (usually architecture for operator-visible decisions) and reference
   from the other.
8. **Acceptance criteria that test outputs but not invariants.** "Run two
   modes; manifest looks the same" doesn't test the chokepoint invariant. Fix:
   add a *direct observation* acceptance (e.g., inspect the subprocess env).
9. **Missing redaction / hygiene coverage for new secrets.** A new credential
   added without extending NFR-2's list, the redaction pattern set, or the
   `safe-env` denylist. Fix: every new secret triggers a sweep of those
   three.
10. **Renumbering existing items.** Inserting a new FR mid-list, a new
    architecture section in the middle, a new decision log entry early. Fix:
    always append.

---

## 7. Reviewer protocol

- **Always run the reviewer before coding** for non-trivial changes.
- **Write the review to a markdown file**, not inline triage. Plan-stage
  reviews land in `plans/review-<slug>-YYYY-MM-DD.md`; post-implementation
  and security reviews land in `docs/reviews/{review,sec-review}-YYYY-MM-DD-<slug>.md`.
  Both locations are temporary working artifacts (see CLAUDE.md "Review
  documents are temporary"); main documents must not cite them.
- **Two passes**: one on requirements + architecture, one on implementation.
  Don't combine.
- **Apply must-fixes; surface ESCALATE items.** Nice-to-have items are
  judgment calls — apply if cheap, defer if expensive, but document the
  deferral.
- **The reviewer doesn't know the user's preferences.** Give it the
  user's context (memory entries, prior decisions) in the prompt or the
  reviewer's recommendations may contradict standing preferences.

---

## 8. Cross-reference hygiene

- **Append, don't renumber.** New FRs, new architecture sections, new decision
  log entries always go at the end of their sequence.
- **When you must insert.** Subsections inside an existing section may insert
  anywhere, but check that the numbers downstream get renumbered too — and
  that no other doc references the inserted-around anchors. (The reviewer
  will catch one of these every time.)
- **Cross-doc references.** If `requirements.md` cites "(architecture §5.2)",
  re-grep after architecture edits. The implementation plan often references
  both — re-grep there too.
- **Feature → requirement table.** Always update §8 of requirements.md when
  adding an FR.

---

## 9. Pruning as you go

The plan documents grow with the project. Trim during the same change that
adds new content:

- **Stale "post-MVP" entries** that have shipped: move from §11 (Post-MVP
  backlog) to §0 (Status) with a one-line "done" note, or delete.
- **Resolved open questions**: move from `plans/open-questions.md` (if it
  exists) into the relevant decision log.
- **Duplicate explanations**: when you find the same fact in two documents,
  decide which is canonical and replace the other with a cross-reference.
- **Comments that explain "why we considered X but chose Y"**: belong in the
  decision log, not as inline asides in the spec.

The `CLAUDE.md` documentation policy applies: keep what matters; cut what
doesn't. A doc that grows unboundedly stops being read.
