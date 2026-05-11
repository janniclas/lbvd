# LLM-based Vulnerability Detector — Open Questions

Decisions that need user input. Resolved items have been folded into
`plans/implementation.md` (§12 Decision log) and `plans/architecture.md`
(decision log + §10.2 GitLab note).

## Open

### O3. Recorded HTTP transcripts (gated on operator setup)

The GitHub reporter contract tests need recorded transcripts to replay
against. This requires a long-lived test repository the recorder can call
into without polluting production. Runbook + automation:

- `scripts/setup-fixtures-repo.sh` — provisions the fixtures repo, labels,
  and PAT storage. Minting the fine-grained PAT itself is manual (GitHub
  exposes no CLI for that).

When the script completes successfully, ping the implementation agent with
the hand-off line printed at the end. That unblocks the `replayTransport`,
`scripts/record-http.ts` harness, and `tests/reporter-contract/` work.

### O4. Concurrency telemetry sampling test

FR-3 acceptance prescribes "sample `active.json` while a run is in flight
and assert `len(active_agents) ≤ concurrency`". The fixture runner is too
fast to make this observable without an artificial delay. Accepted as
deferred — the slot-pool unit test (`tests/unit/slot.test.ts`) covers the
core invariant.

### O5. GitLab reporter

Confirmed post-MVP. `selectReporter()` throws when `vcs.provider=gitlab`.
The reporter interface reserves the seat.

### O8. Default `vcs.exploit_target_repo: ""`

Accepted: the canonical deployment is on a private repository, so the
default targeting the source repo is the right call. The README runbook
surfaces the FR-7 security note ("branches contain runnable exploits") for
operators on shared/public repos.

## Notes for the next pass

- `lint:complexity` script (originally part of the plan's hard constraints
  in `plans/implementation.md` §10) is unimplemented. `tsc --strict` and
  `lint:boundaries` cover most of the rule set today; cyclomatic budget is
  a manual review item. Implement only when a function actually breaches.
- `schemas/config.schema.json` exists as of F5 but is not yet referenced
  from `state.schema.json:config_snapshot` — a `$ref` would tighten the
  round-trip discipline. One-line change; do when next touching either
  schema.

## Questions for the user when back

These are deferred decisions I noted while consolidating. None of them
block anything; they're just worth your eyes:

- **Reporter contract tests vs HTTP-replay layer.** O3 implies the contract
  tests (`tests/reporter-contract/equivalence.test.ts`,
  `branch-name.test.ts`, `issue-body.test.ts`) should land *with* the replay
  layer. Some of those tests (the pure-function ones — `branch-name`,
  `issue-body`) could land independently. Should I split them out and ship
  the pure-function tests now, or wait for the full HTTP-replay landing?
- **Lint complexity.** I can write a simple `lint:complexity` script
  (cyclomatic counter via TypeScript AST) so CI fails on functions over the
  budget instead of relying on review. Is that worth doing?
- **`schemas/config.schema.json`.** Writing it would let
  `state.schema.json:config_snapshot` tighten via `$ref`. Worth doing now,
  or wait until config grows enough that hand-validation is unwieldy?
- **GitLab reporter as a stub.** A 30-line `gitlab.ts` that throws on every
  call is what the current `selectReporter()` substitutes for. Should I
  add it as an explicit `not-implemented` shim so a future implementer has
  the file already created? Or is the throw-from-select cleaner?
- **`tests/reporter-contract/` directory.** Currently does not exist;
  `npm run test:reporter` errors on missing files. Should I create the
  directory with a placeholder no-op test so the script doesn't throw, or
  remove the script from `package.json` until the tests land?

I'll act on whichever you green-light when you return; until then they
sit here.
