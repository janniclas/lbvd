import { test } from "node:test";
import assert from "node:assert/strict";
import { branchName } from "../../src/reporter/branch-name.js";

test("branch-name: tier 1 uses exploit/ prefix", () => {
  assert.equal(branchName(1, "abcdef012345"), "lbvd/exploit/abcdef012345");
});

test("branch-name: tier 2 uses test/ prefix", () => {
  assert.equal(branchName(2, "abcdef012345"), "lbvd/test/abcdef012345");
});

test("branch-name: deterministic — same input, same output (architecture §10.5)", () => {
  const a = branchName(1, "deadbeefcafe");
  const b = branchName(1, "deadbeefcafe");
  assert.equal(a, b);
});

test("branch-name: no timestamps or random suffixes (architecture §10.5)", () => {
  const name = branchName(1, "0123456789ab");
  // Three slash-separated segments; nothing else.
  assert.deepEqual(name.split("/"), ["lbvd", "exploit", "0123456789ab"]);
  // Must not contain any digit-rich tail beyond the fingerprint itself.
  assert.equal(name, "lbvd/exploit/0123456789ab");
});

test("branch-name: distinct fingerprints produce distinct names", () => {
  assert.notEqual(branchName(1, "aaaaaaaaaaaa"), branchName(1, "bbbbbbbbbbbb"));
});

test("branch-name: tier 1 vs tier 2 with same fingerprint produce distinct names", () => {
  assert.notEqual(branchName(1, "abcdef012345"), branchName(2, "abcdef012345"));
});
