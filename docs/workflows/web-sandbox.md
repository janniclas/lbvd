# Running from Claude Code on the web

This guide assumes you've completed [`docs/getting-started.md`](../getting-started.md)
and want to invoke LLM-based Vulnerability Detector from a Claude Code on-the-web session
instead of from your own terminal.

---

## When this is useful

You're already working in Claude Code on the web, the repo is open in
the sandbox, and you'd rather kick off a scan with a slash command than
context-switch to a local terminal. The output (manifest, per-target
artifacts) shows up in the sandbox's filesystem under `.lbvd/`
exactly as it would on your own machine.

---

## Constraints to know about

The web sandbox is more constrained than running on your own machine.
Two restrictions are enforced by LLM-based Vulnerability Detector itself:

1. **Subscription mode only.** The web sandbox always uses your Claude
   subscription — an `ANTHROPIC_API_KEY` set in the sandbox env is
   ignored by Claude Code. LLM-based Vulnerability Detector refuses `auth.mode: api_key` on
   the web sandbox to avoid silent surprises. Set
   `auth.mode: subscription` in your `lbvd.yaml`.
2. **Size limits.** A preflight check refuses very large scans. The
   default thresholds are configurable (`preflight.max_targets`,
   `preflight.max_tree_bytes` in `lbvd.yaml`), but the
   recommended path for big sweeps is to run on your own machine
   instead.

For runs with concurrency above 4, or runs expected to take more than
about two hours, your own machine is the better host regardless.

---

## Set up

1. Mint a Claude OAuth token once on a laptop that can open a browser:

   ```bash
   claude setup-token
   ```

2. In the web sandbox, export the token before invoking the slash
   command:

   ```bash
   export CLAUDE_CODE_OAUTH_TOKEN="<the token from step 1>"
   ```

3. Set `auth.mode: subscription` in `lbvd.yaml`:

   ```yaml
   auth:
     mode: subscription
   output:
     mode: local      # or vcs, see github-reporting.md
   ```

4. (Only if publishing to GitHub from the sandbox.) Export
   `GITHUB_TOKEN` as well.

---

## Run

```
/lbvd scan-all
```

Or `/lbvd scan-changes`, `/lbvd resume <run-id>`,
`/lbvd report <run-id>`. The slash command runs the same CLI as
your own machine — every flag and subcommand from
[`docs/getting-started.md`](../getting-started.md) works.

The slash command performs its own preflight before handing off:

- If `CLAUDE_CODE_OAUTH_TOKEN` isn't set, you'll get a message pointing
  you at `claude setup-token`.
- If you're missing a forge token while `output.mode: vcs` is
  configured, you'll get a message naming the env var.
- `ANTHROPIC_API_KEY` is unset defensively before the engine starts —
  the web sandbox ignores it anyway, and leaving it set would just
  confuse the picture.

---

## Troubleshooting

### Exit code 2, "web sandbox requires auth.mode: subscription"

You have `auth.mode: api_key` (or the default) in `lbvd.yaml`
but you're running in the web sandbox. Edit your config to set
`auth.mode: subscription`.

### Exit code 2, "preflight refused" (size)

Your scan is over the sandbox's threshold. Either lower the surface
area (`scan-changes` instead of `scan-all`, tighter blacklist
patterns), or run on your own machine. See "Tuning what gets scanned"
in [`docs/getting-started.md`](../getting-started.md).

### Other exit codes

Same as on your own machine — see the troubleshooting section in
[`docs/getting-started.md`](../getting-started.md).

---

## Back to the basics

- [Getting started](../getting-started.md) — install, first scan,
  local mode.
- [Reporting to GitHub](github-reporting.md) — publish findings as
  issues and exploit branches.
- `README.md` — full config and flag reference.
