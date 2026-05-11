import { test } from "node:test";
import assert from "node:assert/strict";
import { stage1SystemPrompt } from "../../src/stage1/prompt.js";

test("stage1SystemPrompt: absolute path appears in the scanning line", () => {
  const prompt = stage1SystemPrompt({
    targetFile: "src/auth.ts",
    targetFilePath: "/repo/src/auth.ts",
    scanScope: "hint+verify",
  });
  assert.match(prompt, /You are scanning \/repo\/src\/auth\.ts /);
});

test("stage1SystemPrompt: relative path appears in the target_file JSON template", () => {
  const prompt = stage1SystemPrompt({
    targetFile: "src/auth.ts",
    targetFilePath: "/repo/src/auth.ts",
    scanScope: "hint+verify",
  });
  assert.match(prompt, /"target_file": "src\/auth\.ts"/);
});

test("stage1SystemPrompt: absolute and relative paths are independent", () => {
  const prompt = stage1SystemPrompt({
    targetFile: "src/auth.ts",
    targetFilePath: "/some/other/repo/src/auth.ts",
    scanScope: "hint+verify",
  });
  assert.match(prompt, /You are scanning \/some\/other\/repo\/src\/auth\.ts /);
  assert.match(prompt, /"target_file": "src\/auth\.ts"/);
});

test("stage1SystemPrompt: hint_only scope appears in rules", () => {
  const prompt = stage1SystemPrompt({
    targetFile: "x.ts",
    targetFilePath: "/repo/x.ts",
    scanScope: "hint_only",
  });
  assert.match(prompt, /Scan scope is "hint_only"/);
});

test("stage1SystemPrompt: hint+verify scope appears in rules", () => {
  const prompt = stage1SystemPrompt({
    targetFile: "x.ts",
    targetFilePath: "/repo/x.ts",
    scanScope: "hint+verify",
  });
  assert.match(prompt, /Scan scope is "hint\+verify"/);
});

test("stage1SystemPrompt: throws when targetFilePath is relative", () => {
  assert.throws(
    () =>
      stage1SystemPrompt({
        targetFile: "src/auth.ts",
        targetFilePath: "src/auth.ts",
        scanScope: "hint+verify",
      }),
    /targetFilePath must be absolute/,
  );
});
