import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isWithin,
  confineToParent,
  PathBoundaryError,
  isValidFingerprint,
  isValidRunId,
} from "../../src/util/safe-path.js";

test("isWithin allows children but not parents", () => {
  assert.equal(isWithin("/a/b/c", "/a"), true);
  assert.equal(isWithin("/a", "/a"), true);
  assert.equal(isWithin("/a/b", "/a/c"), false);
  assert.equal(isWithin("/", "/a"), false);
});

test("isWithin rejects sibling-prefix collision (foo vs foobar)", () => {
  assert.equal(isWithin("/foo/bar", "/foo/barbaz"), false);
  assert.equal(isWithin("/foobar/x", "/foo"), false);
});

test("confineToParent rejects '..' escapes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atconf-"));
  fs.writeFileSync(path.join(tmp, "ok.txt"), "ok");
  assert.throws(
    () => confineToParent({ parent: tmp, candidate: "../etc/passwd" }),
    (e: unknown) => e instanceof PathBoundaryError,
  );
});

test("confineToParent rejects absolute paths", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atconf-"));
  assert.throws(
    () => confineToParent({ parent: tmp, candidate: "/etc/passwd" }),
    (e: unknown) => e instanceof PathBoundaryError,
  );
});

test("confineToParent rejects symlink that escapes after realpath", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atconf-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "atoutside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(tmp, "link"));
  assert.throws(
    () => confineToParent({ parent: tmp, candidate: "link", mustExist: true }),
    (e: unknown) => e instanceof PathBoundaryError,
  );
});

test("confineToParent allows in-tree path", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atconf-"));
  fs.writeFileSync(path.join(tmp, "ok.txt"), "ok");
  const r = confineToParent({ parent: tmp, candidate: "ok.txt", mustExist: true });
  assert.ok(r.endsWith("ok.txt"));
});

test("isValidFingerprint enforces 12 lowercase hex", () => {
  assert.equal(isValidFingerprint("abcdef012345"), true);
  assert.equal(isValidFingerprint("ABCDEF012345"), false);
  assert.equal(isValidFingerprint("abcdef01234"), false);
  assert.equal(isValidFingerprint("abcdef0123456"), false);
  assert.equal(isValidFingerprint(null), false);
  assert.equal(isValidFingerprint(""), false);
});

test("isValidRunId enforces YYYYMMDDTHHMMSSZ-<hex> format", () => {
  assert.equal(isValidRunId("20260509T120000Z-deadbeef"), true);
  assert.equal(isValidRunId("20260509T120000Z-cafef00d"), true);
  assert.equal(isValidRunId("../escape"), false);
  assert.equal(isValidRunId("20260509T120000-deadbeef"), false);
});
