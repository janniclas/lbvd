/**
 * Live-agent smoke test. Skipped unless LBVD_LIVE_AGENT=1.
 *
 * Spins up scan-all against a 1-file repo with a planted eval()
 * vulnerability, runs the real Claude Agent SDK through agent-host.ts,
 * and asserts that a finding is produced. Costs real tokens; never run
 * in regular CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const SHOULD_RUN = process.env["LBVD_LIVE_AGENT"] === "1";

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

function repoRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

test(
  "live SDK smoke: scan-all over a planted eval() produces ≥ 1 finding",
  { skip: !SHOULD_RUN },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlivesmoke-"));
    gitInit(root);
    fs.writeFileSync(path.join(root, "eval.js"), "module.exports = (s) => eval(s);\n");
    fs.writeFileSync(
      path.join(root, "lbvd.yaml"),
      [
        "concurrency: 1",
        "output:",
        "  mode: local",
        "scan:",
        "  scope: hint+verify",
        "runner:",
        "  kind: sdk",
        "budgets:",
        "  stage1_per_finding_seconds: 180",
        "  stage2_per_finding_seconds: 600",
        "",
      ].join("\n"),
    );
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

    const tsxBin = path.join(repoRoot(), "node_modules", ".bin", "tsx");
    const cli = path.join(repoRoot(), "src", "cli.ts");
    const result = spawnSync(
      tsxBin,
      [cli, "scan-all", "--config", "lbvd.yaml", "--run-id", "20260509T200000Z-livesmoke"],
      {
        cwd: root,
        env: process.env,
        encoding: "utf8",
        timeout: 15 * 60 * 1000,
      },
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);

    const runDir = path.join(root, ".lbvd", "20260509T200000Z-livesmoke");
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8")) as {
      counts_by_tier: { tier1: number; tier2: number; tier3: number; no_finding: number; failed: number };
      outcomes: { target_file: string; state: string; tier: number | null }[];
    };
    // Only `eval.js` should be enumerated — lbvd.yaml is excluded by
    // the `config_files` built-in blacklist, so the assertion below is
    // not satisfied by an unrelated finding in the YAML.
    assert.equal(manifest.outcomes.length, 1, "exactly one target should be enumerated");
    assert.equal(manifest.outcomes[0]?.target_file, "eval.js");
    const vulnCount =
      manifest.counts_by_tier.tier1 + manifest.counts_by_tier.tier2 + manifest.counts_by_tier.tier3;
    assert.ok(vulnCount >= 1, `expected ≥ 1 vulnerability, got tiers=${JSON.stringify(manifest.counts_by_tier)}`);
  },
);
