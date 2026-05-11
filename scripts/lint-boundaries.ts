#!/usr/bin/env tsx
/**
 * Lint hard constraints from plans/implementation.md §10.
 * Run via `npm run lint:boundaries`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface Rule {
  description: string;
  pattern: RegExp;
  allowFiles: string[];
}

const RULES: Rule[] = [
  {
    description: "No Date.now() / process.hrtime / new Date() outside src/clock/",
    pattern: /\b(Date\.now|process\.hrtime|new Date)\s*\(/,
    allowFiles: ["src/clock/clock.ts", "scripts/lint-boundaries.ts"],
  },
  {
    description: "No console.log / console.error in src/ (except cli.ts for help/usage)",
    pattern: /\bconsole\.(log|error|warn|info)\s*\(/,
    allowFiles: ["src/cli.ts", "scripts/lint-boundaries.ts"],
  },
  {
    description: "No process.stdout.write / process.stderr.write outside the safe helpers",
    pattern: /process\.(stdout|stderr)\.write\s*\(/,
    allowFiles: [
      "src/util/safe-stderr.ts",
      "src/log/log.ts",
      "src/discovery/dry-run.ts",
      "src/manifest/report.ts",
      "src/progress/bar.ts",
      "src/runner/agent-host.ts",
      "src/runner/fixture-host.ts",
      "src/runner/fixture-probe-host.ts",
      "scripts/lint-boundaries.ts",
      "scripts/record-http.ts",
      "scripts/synth-http.ts",
    ],
  },
  {
    description: "No undici import outside src/reporter/ (forge HTTP is reporter-only)",
    pattern: /\bfrom\s+["']undici["']/,
    allowFiles: [
      "src/reporter/http.ts",
      // scripts/ carve-out: operator-driven tooling that must bypass the
      // reporter abstraction (e.g. recorder cleanup must not be captured).
      "scripts/record-http.ts",
    ],
  },
  {
    description:
      "No direct process.env.{ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN,CLAUDE_CODE_OAUTH_TOKEN} reads outside the auth-credential resolver, the env-passthrough chokepoint, and the CLI startup path (plans/implementation.md §10, FR-15 / architecture §20.2)",
    pattern: /process\.env(?:\.|\[\s*["'])\s*(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)\b/,
    allowFiles: [
      "src/config/load.ts",
      "src/runner/safe-env.ts",
      "src/cli.ts",
      "scripts/lint-boundaries.ts",
    ],
  },
  {
    description:
      "No fs.openSync / fs.open with O_CREAT | O_EXCL or wx-mode outside src/app-lock/lock.ts (FR-17 / plans/implementation.md §10)",
    pattern: /fs\.openSync\s*\([^)]*['"]wx['"]\)|fs\.openSync\s*\([^)]*O_(CREAT|EXCL)/,
    allowFiles: [
      "src/app-lock/lock.ts",
      "scripts/lint-boundaries.ts",
    ],
  },
  {
    description:
      "No direct reads/writes of <runDir>/app-access.lock outside src/app-lock/lock.ts (FR-17 / plans/implementation.md §10)",
    pattern: /["']app-access\.lock["']/,
    allowFiles: [
      "src/app-lock/lock.ts",
      "scripts/lint-boundaries.ts",
    ],
  },
  {
    description:
      "Dispatcher-zone <runDir>/app-probe.json writer is src/probe/invoke.ts only (FR-17 / plans/implementation.md §10)",
    pattern: /writeFileSync\s*\(.*app-probe\.json/,
    allowFiles: [
      "src/probe/invoke.ts",
      "src/runner/fixture-probe-host.ts",
      "scripts/lint-boundaries.ts",
    ],
  },
  {
    // Catches `const { ANTHROPIC_API_KEY } = process.env` and similar
    // destructuring forms that the dotted/bracketed rule above misses
    // (sec review M3). Bound-variable reads (`const e = process.env; e.X`)
    // are still not covered — if those appear in future code, extend.
    description:
      "No destructuring read of ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN from process.env outside the three allowlisted files (plans/implementation.md §10, FR-15 / architecture §20.2)",
    pattern: /\{[^}]*\b(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)\b[^}]*\}\s*=\s*process\.env\b/,
    allowFiles: [
      "src/config/load.ts",
      "src/runner/safe-env.ts",
      "src/cli.ts",
      "scripts/lint-boundaries.ts",
    ],
  },
];

function walkSrc(dir: string, acc: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSrc(full, acc);
    else if (entry.isFile() && entry.name.endsWith(".ts")) acc.push(full);
  }
}

function check(file: string, rule: Rule, repoRoot: string): string[] {
  const rel = path.relative(repoRoot, file);
  if (rule.allowFiles.includes(rel)) return [];
  const text = fs.readFileSync(file, "utf8");
  const errors: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (rule.pattern.test(line)) {
      errors.push(`${rel}:${i + 1}: ${rule.description}\n    ${line.trim()}`);
    }
  });
  return errors;
}

function main(): number {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const files: string[] = [];
  walkSrc(path.join(repoRoot, "src"), files);
  walkSrc(path.join(repoRoot, "scripts"), files);
  const allErrors: string[] = [];
  for (const file of files) {
    for (const rule of RULES) {
      allErrors.push(...check(file, rule, repoRoot));
    }
  }
  if (allErrors.length === 0) {
    process.stdout.write(`lint:boundaries OK (${files.length} files)\n`);
    return 0;
  }
  for (const e of allErrors) process.stderr.write(`${e}\n`);
  process.stderr.write(`\n${allErrors.length} boundary violations\n`);
  return 1;
}

process.exit(main());
