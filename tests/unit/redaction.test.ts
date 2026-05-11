import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, makeRedactor } from "../../src/redaction/redact.js";

test("redacts GitHub PAT", () => {
  const s = "token=ghp_" + "a".repeat(40);
  assert.match(redact(s), /<redacted>/);
  assert.doesNotMatch(redact(s), /ghp_aaa/);
});

test("redacts Anthropic key", () => {
  const s = "X-API-Key: sk-ant-api03-" + "x".repeat(40);
  assert.doesNotMatch(redact(s), /sk-ant-api03-xxxx/);
});

test("redacts Claude OAuth token (oat_ prefix)", () => {
  const s = "session: oat_" + "x".repeat(30);
  assert.match(redact(s), /<redacted>/);
  assert.doesNotMatch(redact(s), /oat_xxxx/);
});

test("redacts Bearer token", () => {
  const s = "Authorization: Bearer abc123def";
  assert.match(redact(s), /<redacted>/i);
});

test("redacts JWT-shaped token", () => {
  const s = "session=eyJabc.eyJdef.signaturepart";
  assert.doesNotMatch(redact(s), /eyJabc\.eyJdef/);
});

test("preserves non-secret text", () => {
  assert.equal(redact("hello world"), "hello world");
});

test("redacts generic SECRET=value form", () => {
  const out = redact("API_SECRET=xyzzy");
  assert.match(out, /API_SECRET=<redacted>/);
});

test("makeRedactor masks a literal value anywhere in the string", () => {
  const literal = "oat-this-is-a-fake-token-1234567890";
  const r = makeRedactor({ extraLiterals: [literal] });
  const out = r.redact(`bearer ${literal}; trailing copy: ${literal}.`);
  assert.doesNotMatch(out, /oat-this-is-a-fake-token/);
  assert.match(out, /<redacted>/);
});

test("makeRedactor drops literals shorter than 8 chars and reports the count", () => {
  const r = makeRedactor({ extraLiterals: ["short", "a"] });
  assert.equal(r.literalsKept, 0);
  assert.equal(r.literalsDropped, 2);
  // Short literal must NOT be masked (would otherwise mask harmless substrings).
  assert.equal(r.redact("the word short is benign"), "the word short is benign");
});

test("makeRedactor 8-char floor: a 7-char literal leaks (negative control)", () => {
  // Negative control: if a future change tightens or loosens the floor, this
  // test must fail so the choice is deliberate. Sec review nit.
  const sevenChar = "abcdefg";
  const r = makeRedactor({ extraLiterals: [sevenChar] });
  assert.equal(r.literalsKept, 0);
  assert.equal(r.literalsDropped, 1);
  // The literal is NOT masked — that's the contract of a short-literal drop.
  assert.match(r.redact(`leading ${sevenChar} trailing`), /leading abcdefg trailing/);
});

test("makeRedactor 8-char floor: an exactly-8-char literal is masked (boundary)", () => {
  const eightChar = "abcdefgh";
  const r = makeRedactor({ extraLiterals: [eightChar] });
  assert.equal(r.literalsKept, 1);
  assert.match(r.redact(`leading ${eightChar} trailing`), /leading <redacted> trailing/);
});

test("makeRedactor escapes regex metacharacters in literals", () => {
  const r = makeRedactor({ extraLiterals: ["abc.def[ghi]+jkl"] });
  // Should mask the literal verbatim and only the literal.
  assert.match(r.redact("plain abc.def[ghi]+jkl trailing"), /plain <redacted> trailing/);
  // Should NOT mask a string that matches the regex interpretation.
  assert.equal(r.redact("abcXdefXghiXjkl trailing"), "abcXdefXghiXjkl trailing");
});

test("makeRedactor dedupes identical literals", () => {
  const r = makeRedactor({ extraLiterals: ["aaaaaaaa", "aaaaaaaa", "aaaaaaaa"] });
  assert.equal(r.literalsKept, 1);
});

test("module-level redact() runs with no literals", () => {
  // Sanity: module-level export does not retain literals from a prior makeRedactor call.
  makeRedactor({ extraLiterals: ["unique-literal-zzz12345"] });
  const out = redact("unique-literal-zzz12345 stays here");
  assert.match(out, /unique-literal-zzz12345 stays here/);
});

test("makeRedactor still applies the regex set on top of literals", () => {
  const r = makeRedactor({ extraLiterals: ["abcdefgh"] });
  const out = r.redact("abcdefgh and token=ghp_" + "x".repeat(40));
  assert.match(out, /<redacted>/);
  assert.doesNotMatch(out, /abcdefgh/);
  assert.doesNotMatch(out, /ghp_xxxx/);
});
