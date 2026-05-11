---
description: Run LLM-based Vulnerability Detector (lbvd) inside this Claude Code on-the-web sandbox.
---

```bash
#!/usr/bin/env bash
set -euo pipefail

# Token preflight — at least one VCS token must be present unless running with output.mode=local.
if [ -z "${GITHUB_TOKEN:-}" ] && [ -z "${GITLAB_TOKEN:-}" ]; then
  echo "lbvd: set GITHUB_TOKEN or GITLAB_TOKEN in the sandbox env first," >&2
  echo "or configure output.mode: local in lbvd.yaml." >&2
fi

# FR-15 / architecture §20.4: web sandbox is subscription-only. Best-effort UX —
# the engine's substrate gate is the authoritative check.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "lbvd: web-sandbox requires auth.mode=subscription with CLAUDE_CODE_OAUTH_TOKEN." >&2
  echo "Run 'claude setup-token' on a host with browser access, then export the token here." >&2
  exit 1
fi
# Web-sandbox always ignores ANTHROPIC_API_KEY (the engine substrate gate
# would refuse auth.mode=api_key anyway). Unset it defensively to keep the
# subprocess env clean.
unset ANTHROPIC_API_KEY

# Substrate marker — the engine reads this; slash-command sets it explicitly so detection
# does not depend on a Claude-Code-internal env var.
export LBVD_SUBSTRATE=web-sandbox

exec npx -y lbvd "$@"
```
