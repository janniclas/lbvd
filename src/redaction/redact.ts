import { Transform } from "node:stream";
import { REDACTION_PATTERNS, REDACTED } from "./patterns.js";

export interface Redactor {
  redact(s: string): string;
  redactStream(input: NodeJS.ReadableStream): NodeJS.ReadableStream;
}

// Floor below which a literal is dropped to avoid masking harmless substrings.
// Eight chars is the implementer's heuristic, not a spec-level invariant.
const LITERAL_MIN_LENGTH = 8;

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileLiteralPatterns(literals: readonly string[]): {
  patterns: RegExp[];
  kept: number;
  dropped: number;
} {
  const seen = new Set<string>();
  const patterns: RegExp[] = [];
  let dropped = 0;
  for (const lit of literals) {
    if (lit.length < LITERAL_MIN_LENGTH) {
      dropped += 1;
      continue;
    }
    if (seen.has(lit)) continue;
    seen.add(lit);
    patterns.push(new RegExp(escapeForRegex(lit), "g"));
  }
  return { patterns, kept: patterns.length, dropped };
}

function applyPattern(s: string, pattern: RegExp): string {
  pattern.lastIndex = 0;
  return s.replace(pattern, (match: string, prefix?: string) => {
    if (typeof prefix === "string" && prefix.length > 0) {
      return `${prefix}${REDACTED}`;
    }
    return REDACTED;
  });
}

function makeRedactFn(literalPatterns: readonly RegExp[]): (s: string) => string {
  return (input: string): string => {
    let s = input;
    // Literals run first so a known token is masked even if it does not match
    // any prefix family in REDACTION_PATTERNS.
    for (const pattern of literalPatterns) {
      s = applyPattern(s, pattern);
    }
    for (const pattern of REDACTION_PATTERNS) {
      s = applyPattern(s, pattern);
    }
    return s;
  };
}

function makeRedactStreamFn(
  redactFn: (s: string) => string,
): (input: NodeJS.ReadableStream) => NodeJS.ReadableStream {
  return (input: NodeJS.ReadableStream): NodeJS.ReadableStream => {
    let buffer = "";
    const transform = new Transform({
      transform(chunk: Buffer, _enc, cb): void {
        buffer += chunk.toString("utf8");
        const lastNl = buffer.lastIndexOf("\n");
        if (lastNl < 0) {
          cb();
          return;
        }
        const head = buffer.slice(0, lastNl + 1);
        buffer = buffer.slice(lastNl + 1);
        cb(null, redactFn(head));
      },
      flush(cb): void {
        if (buffer.length > 0) {
          cb(null, redactFn(buffer));
          buffer = "";
          return;
        }
        cb();
      },
    });
    input.pipe(transform);
    return transform;
  };
}

export interface MakeRedactorOpts {
  extraLiterals?: readonly string[];
}

export interface MakeRedactorResult extends Redactor {
  literalsKept: number;
  literalsDropped: number;
}

export function makeRedactor(opts: MakeRedactorOpts = {}): MakeRedactorResult {
  const { patterns, kept, dropped } = compileLiteralPatterns(opts.extraLiterals ?? []);
  const redactFn = makeRedactFn(patterns);
  const streamFn = makeRedactStreamFn(redactFn);
  return {
    redact: redactFn,
    redactStream: streamFn,
    literalsKept: kept,
    literalsDropped: dropped,
  };
}

// Module-level fallback singleton for pre-`Logger` callers (e.g., cli.ts
// startup error paths) and for code wired before makeRedactor is available.
// Runs the regex set only — no literal masking. Any path that must mask the
// per-run auth credential must use the threaded `Redactor` from `cli.ts`
// instead (see safe-stderr.ts and the runner factories).
const MODULE_LEVEL_FALLBACK = makeRedactor();

export function redact(input: string): string {
  return MODULE_LEVEL_FALLBACK.redact(input);
}

export function redactStream(input: NodeJS.ReadableStream): NodeJS.ReadableStream {
  return MODULE_LEVEL_FALLBACK.redactStream(input);
}
