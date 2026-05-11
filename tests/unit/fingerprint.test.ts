import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, infraNamespace, normalizeSnippet } from "../../src/identity/fingerprint.js";

test("fingerprint is 12 hex chars", () => {
  const fp = fingerprint({ category: "sql_injection", snippet: "SELECT * FROM x" });
  assert.match(fp, /^[0-9a-f]{12}$/);
});

test("fingerprint is deterministic", () => {
  const a = fingerprint({ category: "x", snippet: "abc def" });
  const b = fingerprint({ category: "x", snippet: "abc def" });
  assert.equal(a, b);
});

test("fingerprint differs on category change", () => {
  const a = fingerprint({ category: "x", snippet: "abc" });
  const b = fingerprint({ category: "y", snippet: "abc" });
  assert.notEqual(a, b);
});

test("fingerprint stable under whitespace + comments", () => {
  const a = fingerprint({ category: "c", snippet: "  let x = 1; // a comment\n" });
  const b = fingerprint({ category: "c", snippet: "let x = 1;" });
  assert.equal(a, b);
});

test("normalize strips block comment", () => {
  assert.equal(normalizeSnippet("a /* x */ b"), "a b");
});

test("infra namespace separated", () => {
  const fp = "abcdef012345";
  assert.equal(infraNamespace(fp), `${fp}:infra`);
  assert.notEqual(fp, infraNamespace(fp));
});
