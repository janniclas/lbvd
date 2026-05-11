/**
 * Capability gate for the Claude Agent SDK's tool calls.
 *
 * Every SDK tool invocation is routed through `decideToolUse`, which
 * returns either an `allow` or `deny` PermissionResult. The decision is
 * load-bearing for the security posture documented in
 * architecture.md §1.3.1 and §7.3 — prompts may *describe* the rules but
 * the gate is the truth.
 *
 * Inputs:
 * - `caps`: the capability set from the dispatcher.
 *   Stage 1 = ["fs:read", "fs:write:targetSubtree"];
 *   Stage 2 = ["fs:read", "fs:write", "fs:write:targetSubtree", "net", "shell"].
 *   `fs:write:targetSubtree` is the explicit, documented carve-out for
 *   the agent producing `finding.json` / `outcome.json` in its own
 *   working directory.
 * - `repoRoot`: realpath of the source repo. Reads are confined here.
 *   The caller MUST pre-realpath this; `decideRead` realpaths the candidate
 *   before the prefix-check (defense-in-depth, but the parent must be
 *   canonical so the comparison is meaningful).
 * - `targetSubtree`: realpath of the per-target output dir. Writes are
 *   confined here.
 * - `targetFile`: relative path of the file under scrutiny. Used for
 *   `hint_only` scope where reads beyond the hinted file are denied.
 * - `scanScope`: `hint_only` | `hint+verify` | `repo_wide`.
 */
import * as path from "node:path";
import { confineToParent, isWithin, PathBoundaryError } from "../util/safe-path.js";
import type { Capability } from "./interface.js";

export interface ShimGate {
  caps: Capability[];
  repoRoot: string;
  targetSubtree: string;
  targetFile: string;
  scanScope: "hint_only" | "hint+verify" | "repo_wide";
}

export type ToolDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const NET_TOOLS = new Set(["WebFetch", "WebSearch"]);
const SHELL_TOOLS = new Set(["Bash", "BashOutput", "KillShell"]);
// Tools the agent does not need; explicitly denied to keep the surface tight.
const DENIED_TOOLS = new Set(["Agent", "Task", "TaskCreate", "TaskUpdate"]);

function deny(msg: string): ToolDecision {
  return { behavior: "deny", message: msg };
}

function allowed(): ToolDecision {
  return { behavior: "allow" };
}

function pathFromInput(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === "string" ? v : null;
}

// Read-tool input keys. Read uses `file_path`, Glob uses `path` for the
// search root, and Grep uses `path` (the search root). Grep's `pattern` is
// the regex, NOT a path — deliberately excluded from path resolution.
function readPathFromInput(input: Record<string, unknown>): string | null {
  return pathFromInput(input, "file_path") ?? pathFromInput(input, "path");
}

// Realpath-confine `candidate` against either parent. We require it to be
// inside one of {repoRoot, targetSubtree}. Returns the realpath on success
// or a deny on failure. Always succeeds for relative paths because
// `confineToParent`'s realpath step canonicalizes through any symlinks.
function confineToEither(
  candidate: string,
  repoRoot: string,
  targetSubtree: string,
): { ok: true; resolved: string } | { ok: false; reason: string } {
  // `confineToParent` rejects absolute candidates by design (its API is
  // "join this RELATIVE candidate to parent"). For an absolute candidate,
  // strip the parent prefix lexically first, then confine.
  const tryConfine = (parent: string, c: string): string | null => {
    try {
      return confineToParent({ parent, candidate: c, mustExist: false });
    } catch (e) {
      if (e instanceof PathBoundaryError) return null;
      throw e;
    }
  };
  // Try repoRoot first. If absolute, derive the relative form.
  const tryParent = (parent: string): string | null => {
    if (path.isAbsolute(candidate)) {
      const rel = path.relative(parent, candidate);
      // path.relative may produce "" or "../..", both of which confineToParent rejects.
      if (rel === "" || rel.startsWith("..")) return null;
      return tryConfine(parent, rel);
    }
    return tryConfine(parent, candidate);
  };
  const inRepo = tryParent(repoRoot);
  if (inRepo !== null) return { ok: true, resolved: inRepo };
  const inSubtree = tryParent(targetSubtree);
  if (inSubtree !== null) return { ok: true, resolved: inSubtree };
  return { ok: false, reason: `path '${candidate}' resolves outside repoRoot and targetSubtree` };
}

function decideRead(input: Record<string, unknown>, gate: ShimGate): ToolDecision {
  if (!gate.caps.includes("fs:read")) return deny("fs:read capability not granted");
  const candidate = readPathFromInput(input);
  if (candidate === null) return allowed();
  // For glob/grep, the candidate may be a glob — confine the literal path
  // component before any wildcard. An empty literal prefix (e.g., the bare
  // pattern "*") cannot be confined and must be rejected — otherwise a
  // glob without an anchor escapes.
  const literalPrefix = stripGlob(candidate);
  if (literalPrefix === "") {
    return deny(`read denied: pattern '${candidate}' has no literal prefix to confine`);
  }
  const confine = confineToEither(literalPrefix, gate.repoRoot, gate.targetSubtree);
  if (!confine.ok) return deny(`read denied: ${confine.reason}`);
  if (gate.scanScope === "hint_only") {
    const expected = path.resolve(gate.repoRoot, gate.targetFile);
    if (confine.resolved !== expected) {
      return deny(
        `read denied (scope=hint_only, only ${gate.targetFile} allowed): ${confine.resolved}`,
      );
    }
  }
  return allowed();
}

function decideWrite(input: Record<string, unknown>, gate: ShimGate): ToolDecision {
  // Writes require an explicit `fs:write:targetSubtree` capability — the
  // documented carve-out so stage 1 (whose declared caps are
  // ["fs:read", "fs:write:targetSubtree"]) can produce finding.json
  // without granting full fs:write. Stage 2 carries both fs:write and
  // fs:write:targetSubtree.
  if (
    !gate.caps.includes("fs:write") &&
    !gate.caps.includes("fs:write:targetSubtree")
  ) {
    return deny("write denied: no fs:write* capability granted");
  }
  const candidate = pathFromInput(input, "file_path") ?? pathFromInput(input, "path");
  if (candidate === null) return deny("write denied: missing file_path/path");
  const abs = path.isAbsolute(candidate) ? candidate : path.resolve(gate.targetSubtree, candidate);
  const rel = path.relative(gate.targetSubtree, abs);
  if (rel === "" || rel === ".") {
    return deny("write denied: writing to targetSubtree root is not allowed");
  }
  try {
    confineToParent({
      parent: gate.targetSubtree,
      candidate: rel,
      mustExist: false,
    });
  } catch (e) {
    if (e instanceof PathBoundaryError) return deny(`write denied: ${e.message}`);
    throw e;
  }
  // Belt-and-suspenders for the lexical post-prefix-check: if not in repoRoot,
  // the only allowed write target is targetSubtree.
  if (!isWithin(abs, gate.targetSubtree)) {
    return deny(`write denied: '${abs}' resolves outside targetSubtree`);
  }
  return allowed();
}

function decideShell(gate: ShimGate): ToolDecision {
  if (!gate.caps.includes("shell")) return deny("shell capability not granted");
  return allowed();
}

function decideNet(gate: ShimGate): ToolDecision {
  if (!gate.caps.includes("net")) return deny("net capability not granted");
  return allowed();
}

function stripGlob(p: string): string {
  // Trim the path at the first wildcard so we can confine the literal prefix.
  const idx = p.search(/[*?[]/);
  return idx < 0 ? p : p.slice(0, idx);
}

export function decideToolUse(
  toolName: string,
  input: Record<string, unknown>,
  gate: ShimGate,
): ToolDecision {
  if (DENIED_TOOLS.has(toolName)) return deny(`tool '${toolName}' is not allowed in this stage`);
  if (READ_TOOLS.has(toolName)) return decideRead(input, gate);
  if (WRITE_TOOLS.has(toolName)) return decideWrite(input, gate);
  if (NET_TOOLS.has(toolName)) return decideNet(gate);
  if (SHELL_TOOLS.has(toolName)) return decideShell(gate);
  // Unknown tool: deny by default. The agent will adjust.
  return deny(`tool '${toolName}' not in capability allowlist`);
}
