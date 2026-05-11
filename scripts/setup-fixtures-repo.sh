#!/usr/bin/env bash
#
# scripts/setup-fixtures-repo.sh
#
# Provisions the long-lived GitHub repository that the reporter
# contract-tests record against.
#
# What is automated:
#   - Pre-flight (gh CLI, git, auth status).
#   - gh repo create … --private --add-readme (idempotent).
#   - Pre-creating the 8 labels the reporter expects.
#   - Verifying the PAT against the live API (read repo, list labels, read
#     default-branch ref, negative test against another repo).
#   - Storing the token in macOS Keychain or in ~/.config/lbvd/.
#
# What requires the user:
#   - Generating the fine-grained PAT in the browser (GitHub does not
#     expose a CLI for fine-grained PAT creation). The script opens the
#     URL, prints the exact form values, and waits for you to paste the
#     token.
#   - Choosing where to store the token.
#
# Re-running the script is safe: every step short-circuits if its
# postcondition is already in place.
#
# --dry-run prints every mutating command without executing it and skips
# Steps 3-5 (PAT mint/verify/store, which need a real token). Read-only
# checks still run, so you can preview what state the script will find
# and what it would do before running for real.

set -euo pipefail

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

REPO="${LBVD_FIXTURES_REPO:-janniclas/lbvd-fixtures}"
LABELS=(
  "lbvd"
  "priority:high"
  "priority:medium"
  "priority:low"
  "tier:1"
  "tier:2"
  "tier:3"
  "lbvd:infra"
)
LABEL_COLOR="BFD4F2"
LABEL_DESCRIPTION="LBVD contract-test label"
KEYCHAIN_SERVICE="LBVD_FIXTURES_GITHUB_TOKEN"
DOTFILE_DIR="${HOME}/.config/lbvd"
DOTFILE_PATH="${DOTFILE_DIR}/fixtures.env"
DRY_RUN=0

# --------------------------------------------------------------------------
# Output helpers (TTY-aware ANSI)
# --------------------------------------------------------------------------

if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""
fi

step()    { printf "\n%s==> %s%s\n" "${C_BOLD}${C_BLUE}" "$*" "${C_RESET}"; }
ok()      { printf "%s ✔ %s%s\n" "${C_GREEN}" "$*" "${C_RESET}"; }
warn()    { printf "%s ! %s%s\n" "${C_YELLOW}" "$*" "${C_RESET}"; }
fail()    { printf "%s ✖ %s%s\n" "${C_RED}" "$*" "${C_RESET}" >&2; }
info()    { printf "%s   %s%s\n" "${C_DIM}" "$*" "${C_RESET}"; }
prompt()  { printf "%s ?  %s%s " "${C_CYAN}" "$*" "${C_RESET}"; }

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "missing required command: $cmd"
    exit 2
  fi
}

ask_continue() {
  local msg="${1:-Continue?}"
  prompt "${msg} [y/N]"
  local answer=""
  read -r answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *)
      fail "aborted by user"
      exit 1
      ;;
  esac
}

usage() {
  cat <<EOF
Usage: $0 [--dry-run]

Provisions the LBVD fixtures repo, labels, and PAT storage.

Options:
  --dry-run   Print mutating commands without running them. Pre-flight
              and read-only checks still run; PAT mint/verify/store
              (Steps 3-5) are skipped — there's no token to verify.
  -h, --help  Show this message.

Environment:
  LBVD_FIXTURES_REPO   Target repo (default: janniclas/lbvd-fixtures).
EOF
}

parse_args() {
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      -h|--help) usage; exit 0 ;;
      *)
        fail "unknown argument: $arg"
        usage >&2
        exit 2
        ;;
    esac
  done
}

# In dry-run mode, print the would-be command (shell-quoted so it's
# directly copy-pasteable) instead of running it. In real mode, exec
# the command and let its exit status propagate.
run() {
  if [ "$DRY_RUN" = "1" ]; then
    local quoted
    quoted="$(printf '%q ' "$@")"
    printf "%s   would run: %s%s\n" "${C_DIM}" "${quoted% }" "${C_RESET}"
    return 0
  fi
  "$@"
}

# --------------------------------------------------------------------------
# Step 0 — Pre-flight
# --------------------------------------------------------------------------

preflight() {
  step "Step 0 / Pre-flight"
  require_cmd gh
  require_cmd git
  require_cmd curl
  ok "gh, git, curl present"

  if ! gh auth status >/dev/null 2>&1; then
    fail "'gh' is not authenticated. Run:  gh auth login"
    exit 2
  fi
  local user
  user="$(gh api user --jq .login)"
  ok "gh authenticated as ${user}"

  info "target repo: ${C_BOLD}${REPO}${C_RESET}"
  if [ -z "$REPO" ] || [[ "$REPO" != */* ]]; then
    fail "REPO must be in '<owner>/<name>' form (got: '$REPO')"
    exit 2
  fi
}

# --------------------------------------------------------------------------
# Step 1 — Create repository (idempotent)
# --------------------------------------------------------------------------

ensure_repo() {
  step "Step 1 / Create the repository (private, with main branch)"
  if gh repo view "$REPO" >/dev/null 2>&1; then
    ok "repo ${REPO} already exists"
  else
    info "creating ${REPO} as private with an initial README commit ..."
    run gh repo create "$REPO" \
      --private \
      --description "Recording target for LBVD GitHub reporter contract tests. Not for production data." \
      --add-readme
    if [ "$DRY_RUN" = "1" ]; then
      info "(dry-run) repo would be freshly created; skipping default-branch + main-ref checks"
      return 0
    fi
    ok "created ${REPO}"
  fi

  local default_branch
  default_branch="$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name)"
  if [ "$default_branch" != "main" ]; then
    warn "default branch is '${default_branch}', renaming to 'main'"
    run gh repo edit "$REPO" --default-branch main
    [ "$DRY_RUN" = "1" ] || ok "default branch is now 'main'"
  else
    ok "default branch is 'main'"
  fi

  # Confirm the initial commit exists — the recorder needs git/refs/heads/main
  # to resolve. If --add-readme was skipped on a pre-existing repo, the API
  # would 404 on the very first recorded call.
  if ! gh api "repos/${REPO}/git/refs/heads/main" >/dev/null 2>&1; then
    fail "${REPO} has no commits on main; recorder cannot base branches off it."
    fail "Add at least one commit (e.g. README) before continuing."
    exit 2
  fi
  ok "main has ≥ 1 commit (recorder can base branches off it)"
}

# --------------------------------------------------------------------------
# Step 2 — Pre-create labels (idempotent)
# --------------------------------------------------------------------------

ensure_labels() {
  step "Step 2 / Pre-create the 8 reporter labels"
  for label in "${LABELS[@]}"; do
    if gh label list --repo "$REPO" --limit 100 --json name --jq '.[].name' 2>/dev/null \
        | grep -Fxq "$label"; then
      ok "label exists: ${label}"
    else
      run gh label create "$label" \
        --repo "$REPO" \
        --color "$LABEL_COLOR" \
        --description "$LABEL_DESCRIPTION"
      [ "$DRY_RUN" = "1" ] || ok "label created: ${label}"
    fi
  done
}

# --------------------------------------------------------------------------
# Step 3 — Mint the fine-grained PAT (manual; we wait for user)
# --------------------------------------------------------------------------

PAT_URL="https://github.com/settings/personal-access-tokens/new"

prompt_for_token() {
  step "Step 3 / Mint the fine-grained PAT (manual step)"
  if [ "$DRY_RUN" = "1" ]; then
    info "(dry-run) would open ${PAT_URL} and prompt for the token"
    return 0
  fi
  cat <<EOF
${C_BOLD}Open this URL in a browser:${C_RESET}
  ${PAT_URL}

Fill in the form exactly:

  Token name           : lbvd-fixtures-recorder
  Expiration           : 90 days   ${C_DIM}(set a calendar reminder to rotate)${C_RESET}
  Repository access    : Only select repositories  →  ${C_BOLD}${REPO}${C_RESET}
  Description          : Re-record harness for LBVD GitHub reporter contract tests

  Repository permissions (everything else: No access):
    Contents       : Read and write
    Issues         : Read and write
    Metadata       : Read-only            ${C_DIM}(auto-included)${C_RESET}
    Pull requests  : No access
    Workflows      : No access

  Account permissions  : all No access

Click ${C_BOLD}Generate token${C_RESET}. Copy the token (GitHub shows it once).
EOF

  # Best-effort: open the URL. macOS = open, Linux = xdg-open (if present).
  if command -v open >/dev/null 2>&1; then
    open "$PAT_URL" 2>/dev/null || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$PAT_URL" >/dev/null 2>&1 || true
  fi

  echo ""
  prompt "Paste the token (input is hidden):"
  # `-s` hides the input. `IFS=` and `-r` keep edge bytes as-is.
  IFS= read -rs TOKEN
  echo ""
  if [ -z "${TOKEN:-}" ]; then
    fail "no token entered"
    exit 1
  fi
  if [[ ! "$TOKEN" =~ ^github_pat_[A-Za-z0-9_]+$ ]]; then
    warn "token does not look like a fine-grained PAT (expected prefix github_pat_)."
    warn "Continuing anyway — the API verify step will catch a bad token."
  fi
  ok "token captured (length=${#TOKEN})"
}

# --------------------------------------------------------------------------
# Step 4 — Verify the PAT against the live API
# --------------------------------------------------------------------------

verify_token() {
  step "Step 4 / Verify the PAT against the live API"
  if [ "$DRY_RUN" = "1" ]; then
    info "(dry-run) would probe /repos/${REPO}, /labels, /git/refs/heads/main (expect 200)"
    info "(dry-run) would probe a sibling repo under ${REPO%%/*} (expect 404)"
    return 0
  fi

  api_check() {
    local label="$1" path="$2" expect="$3"
    local code
    code="$(curl -sS -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com${path}")"
    if [ "$code" = "$expect" ]; then
      ok "${label}: HTTP ${code}"
    else
      fail "${label}: expected HTTP ${expect}, got ${code}  (path: ${path})"
      return 1
    fi
  }

  api_check "read repo metadata" "/repos/${REPO}" 200
  api_check "list labels"        "/repos/${REPO}/labels" 200
  api_check "read main ref"      "/repos/${REPO}/git/refs/heads/main" 200

  # Negative test: the token MUST NOT see other repos. The owner of REPO
  # almost certainly has other repos — but listing them via the user API is
  # noisy and depends on visibility. Instead, probe a known repo on the same
  # owner that the token is NOT scoped to, and expect 404. The lookup uses
  # the operator's gh auth (which can see siblings); the probe uses the PAT.
  local owner="${REPO%%/*}"
  local fixt="${REPO#*/}"
  local probe_repo
  probe_repo="$(gh repo list "$owner" --limit 100 --json name \
    --jq "map(select(.name != \"$fixt\")) | first | .name")"
  if [ -n "${probe_repo:-}" ] && [ "$probe_repo" != "null" ]; then
    api_check "negative: ${owner}/${probe_repo} unreachable" "/repos/${owner}/${probe_repo}" 404
  else
    info "skipped negative-scope check (no other repo found under ${owner})"
  fi
}

# --------------------------------------------------------------------------
# Step 5 — Persist the token
# --------------------------------------------------------------------------

store_in_keychain() {
  if ! command -v security >/dev/null 2>&1; then
    fail "macOS 'security' CLI not found; cannot use Keychain on this host"
    return 1
  fi
  # Idempotent: delete-if-exists, then add.
  security delete-generic-password \
    -a "$USER" -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1 || true
  security add-generic-password \
    -a "$USER" \
    -s "$KEYCHAIN_SERVICE" \
    -w "$TOKEN"
  ok "stored in Keychain (service=${KEYCHAIN_SERVICE})"
  cat <<EOF

To export the token in a shell later:

  export LBVD_FIXTURES_GITHUB_TOKEN="\$(security find-generic-password \\
    -a \"\$USER\" -s \"${KEYCHAIN_SERVICE}\" -w)"
EOF
}

store_in_dotfile() {
  mkdir -p "$DOTFILE_DIR"
  chmod 700 "$DOTFILE_DIR"
  umask 077
  printf 'LBVD_FIXTURES_GITHUB_TOKEN=%s\n' "$TOKEN" > "$DOTFILE_PATH"
  chmod 600 "$DOTFILE_PATH"
  ok "stored at ${DOTFILE_PATH} (mode 600)"
  cat <<EOF

To source the token in a shell later:

  set -a; . ${DOTFILE_PATH}; set +a
EOF
}

store_token() {
  step "Step 5 / Persist the token"
  if [ "$DRY_RUN" = "1" ]; then
    info "(dry-run) would prompt for storage location (Keychain | ${DOTFILE_PATH} | skip)"
    return 0
  fi
  cat <<EOF
Pick a storage location:

  1) macOS Keychain     ${C_DIM}(recommended on macOS)${C_RESET}
  2) ${DOTFILE_PATH}     ${C_DIM}(mode 600 dotfile, works anywhere)${C_RESET}
  3) Skip — I'll store it myself

EOF
  prompt "Choice [1-3]:"
  local choice=""
  read -r choice
  case "$choice" in
    1) store_in_keychain || { warn "falling back to dotfile"; store_in_dotfile; } ;;
    2) store_in_dotfile ;;
    3) warn "token NOT persisted by this script. Save it now or it is lost."
       info "the in-memory token is also discarded when this script exits."
       ;;
    *) fail "invalid choice '${choice}'"; exit 1 ;;
  esac
}

# --------------------------------------------------------------------------
# Step 6 — Hand-off message
# --------------------------------------------------------------------------

handoff() {
  step "Step 6 / Hand-off"
  if [ "$DRY_RUN" = "1" ]; then
    info "(dry-run) finished. Re-run without --dry-run to perform the actions above."
    return 0
  fi
  cat <<EOF
The fixtures repo is ready. When you next ask the implementation agent to
land Phase 3.3 of plans/implementation-followup.md, paste this:

  > Fixtures repo ${REPO} exists; default branch 'main' has an initial
  > commit; the eight LBVD labels are pre-created; a fine-grained
  > PAT is stored as LBVD_FIXTURES_GITHUB_TOKEN.

Next implementation work (does NOT need to happen now):
  - src/reporter/http.ts: pluggable transport (live + replay).
  - scripts/record-http.ts: re-record harness, gated by LBVD_RECORD_HTTP=1.
  - tests/fixtures/http/github/: committed transcript corpus.
  - tests/reporter-contract/: equivalence + branch-name + issue-body tests.

To rotate the PAT in 90 days:  re-run this script — it will recreate the
keychain entry / dotfile in place.
EOF
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

main() {
  parse_args "$@"
  if [ "$DRY_RUN" = "1" ]; then
    printf "%s   running in --dry-run mode: read-only checks run, mutating commands print only.%s\n" \
      "${C_DIM}" "${C_RESET}"
  fi
  preflight
  ensure_repo
  ensure_labels
  prompt_for_token
  verify_token
  store_token
  handoff
}

main "$@"
