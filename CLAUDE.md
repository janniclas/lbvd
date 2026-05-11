# CLAUDE.md

Agent guidance for this repo. User-facing docs live in `README.md`; this
file covers only what isn't obvious from the tree.

## Complexity budget

Keep both **cyclomatic** and **cognitive** complexity **≤ 10** per
function/method. This applies to new code and to any function you touch — if
an edit pushes a function over the budget, split it as part of the same
change. Exception: flat dispatch (switch/match over a closed set of cases)
may exceed the cyclomatic budget if cognitive complexity stays ≤ 10 and
there's no nested logic inside branches.

- **Cyclomatic** counts branches (if/else, case, &&/||, loops, catches).
  Over budget usually means the function does more than one thing — extract
  the inner decision into its own helper.
- **Cognitive** counts nesting depth + flow-breaking constructs. Over budget
  usually means deeply nested conditionals or mixed loops-and-branches —
  flatten with early returns, or pull the inner loop body into a helper.

Indicators you've exceeded the budget before measuring: >50 lines, >3
nesting levels, a comment explaining "what this block does", or duplicated
scaffolding across two+ sibling functions (a sign the shared skeleton
should be a helper).

## Documentation

Keep documentation current but concise. When a change alters behavior,
interfaces, or decisions that future agents/readers need, update the
relevant doc in the same change — but only capture what matters. Don't add
bloat, restate the obvious, or pad with motivation that the diff already
shows. Prefer editing existing sections over appending new ones; prune
stale content as you go so docs don't grow unbounded.

## Plan documents (`plans/`)

Three files, each with a sharply scoped role:

- **`plans/requirements.md`** — the *what*. Requirements, features,
  acceptance criteria, supported workflows, feature→requirement mapping.
  No technical decisions, no schemas, no file paths, no commands.
- **`plans/architecture.md`** — the *how*, at concept level. Architectural
  principles, module seams, contracts and invariants, the decision log.
  No concrete code, no exact filenames, no library pins, no function
  signatures.
- **`plans/implementation.md`** — the *how*, concretely. File paths,
  function signatures, exact schemas, library choices, phased build
  sequence, test inventory. Derived from `requirements.md` +
  `architecture.md`; the implementation agent's input.

Anything a coding agent already knows (generic Node patterns, standard
tsconfig flags, conventional error handling) is bloat; cut it. Keep each
document scoped to its layer — requirements stays at the *what*,
architecture stays at the *how-concept*, implementation owns the concrete.

For non-trivial plan changes (new FR, new architecture section, refactor
crossing modules), follow the workflow + recurring failure modes in
`plans/agent-guide.md`, and run `plan-reviewer-architect` on requirements
+ architecture, then again on the implementation derivation.

## Review documents are temporary

Anything matching `docs/reviews/review-*.md`, `docs/reviews/sec-review-*.md`,
or `plans/review-*.md` is a one-shot working artifact — output of a
reviewer agent for a specific change. Main documents (`README.md`,
`CLAUDE.md`, `plans/{requirements,architecture,implementation,
agent-guide,open-questions}.md`) must not link to or rely on review files;
content worth keeping after the change ships gets folded into the
appropriate main document and the review file is left to age out.
`agent-guide.md` may name the filename pattern when describing the review
*process*, but must not cite specific review files as references.
