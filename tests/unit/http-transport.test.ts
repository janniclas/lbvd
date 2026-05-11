import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  setTransportForTesting,
  getTransport,
  makeReplayTransport,
  makeRecordingTransport,
  httpJson,
  HttpError,
  type Transport,
} from "../../src/reporter/http.js";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lbvd-http-${prefix}-`));
}

function writeTranscript(dir: string, name: string, content: unknown): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
}

test("replay transport: matches by canonical key (method + url + body)", async () => {
  const dir = tmpDir("replay");
  fs.writeFileSync(
    path.join(dir, "01.json"),
    JSON.stringify({
      request: { method: "GET", url: "https://api.github.com/x", body: null },
      response: { status: 200, body: { ok: true }, headers: {} },
    }),
  );
  setTransportForTesting(makeReplayTransport(dir));
  try {
    const res = await httpJson({ method: "GET", url: "https://api.github.com/x" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  } finally {
    setTransportForTesting(null);
  }
});

test("replay transport: same key consumed in filename-sorted order", async () => {
  const dir = tmpDir("replay-order");
  const url = "https://api.github.com/search";
  for (const [name, body] of [
    ["01-miss.json", { total_count: 0, items: [] }],
    ["02-hit.json",  { total_count: 1, items: [{ url: "x" }] }],
  ] as const) {
    fs.writeFileSync(
      path.join(dir, name),
      JSON.stringify({
        request: { method: "GET", url, body: null },
        response: { status: 200, body, headers: {} },
      }),
    );
  }
  setTransportForTesting(makeReplayTransport(dir));
  try {
    const first = await httpJson({ method: "GET", url });
    const second = await httpJson({ method: "GET", url });
    assert.deepEqual(first.body, { total_count: 0, items: [] });
    assert.deepEqual(second.body, { total_count: 1, items: [{ url: "x" }] });
  } finally {
    setTransportForTesting(null);
  }
});

test("replay transport: throws when no matching transcript", async () => {
  const dir = tmpDir("replay-miss");
  setTransportForTesting(makeReplayTransport(dir));
  try {
    await assert.rejects(
      () => httpJson({ method: "GET", url: "https://api.github.com/missing" }),
      /no recorded transcript/,
    );
  } finally {
    setTransportForTesting(null);
  }
});

test("replay transport: throws when transcripts exhausted", async () => {
  const dir = tmpDir("replay-exhaust");
  fs.writeFileSync(
    path.join(dir, "01.json"),
    JSON.stringify({
      request: { method: "GET", url: "https://api.github.com/x", body: null },
      response: { status: 200, body: {}, headers: {} },
    }),
  );
  setTransportForTesting(makeReplayTransport(dir));
  try {
    await httpJson({ method: "GET", url: "https://api.github.com/x" });
    await assert.rejects(
      () => httpJson({ method: "GET", url: "https://api.github.com/x" }),
      /transcript exhausted/,
    );
  } finally {
    setTransportForTesting(null);
  }
});

test("replay transport: canonical body key is order-independent for objects", async () => {
  const dir = tmpDir("replay-canonical");
  fs.writeFileSync(
    path.join(dir, "01.json"),
    JSON.stringify({
      request: {
        method: "POST",
        url: "https://api.github.com/x",
        body: { a: 1, b: 2 },
      },
      response: { status: 201, body: { ok: 1 }, headers: {} },
    }),
  );
  setTransportForTesting(makeReplayTransport(dir));
  try {
    // Body keys reordered — should still match.
    const res = await httpJson({
      method: "POST",
      url: "https://api.github.com/x",
      body: { b: 2, a: 1 },
    });
    assert.equal(res.status, 201);
  } finally {
    setTransportForTesting(null);
  }
});

test("httpJson: 4xx response surfaces as HttpError", async () => {
  const fakeTransport: Transport = {
    async request() {
      return { status: 404, body: { message: "Not Found" }, headers: {} };
    },
  };
  setTransportForTesting(fakeTransport);
  try {
    await assert.rejects(
      () => httpJson({ method: "GET", url: "https://api.github.com/missing" }),
      (e: unknown) => e instanceof HttpError && e.status === 404,
    );
  } finally {
    setTransportForTesting(null);
  }
});

test("httpJson: redacts URL path in error messages (no repo PII)", async () => {
  const fakeTransport: Transport = {
    async request() {
      return { status: 500, body: "boom", headers: {} };
    },
  };
  setTransportForTesting(fakeTransport);
  try {
    let caught: unknown;
    try {
      await httpJson({ method: "GET", url: "https://api.github.com/repos/secret/private" });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof HttpError);
    assert.ok(!(caught.message.includes("secret") || caught.message.includes("private")));
    assert.ok(caught.message.includes("api.github.com"));
  } finally {
    setTransportForTesting(null);
  }
});

test("recording transport: response headers are stripped to content-type only", async () => {
  const dir = tmpDir("record-headers");
  const fakeInner: Transport = {
    async request() {
      return {
        status: 200,
        body: { ok: true },
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer leaked-token-should-not-be-recorded",
          "x-ratelimit-remaining": "4999",
          "x-github-request-id": "ABCD:1234",
        },
      };
    },
  };
  const recorder = makeRecordingTransport(dir, fakeInner);
  await recorder.request({ method: "GET", url: "https://api.github.com/x" });
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  assert.equal(files.length, 1);
  const transcript = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), "utf8")) as {
    response: { headers: Record<string, string> };
  };
  // Only content-type retained; auth and rate-limit headers stripped.
  assert.deepEqual(Object.keys(transcript.response.headers).sort(), ["content-type"]);
  assert.ok(!JSON.stringify(transcript).includes("leaked-token-should-not-be-recorded"));
});

test("recording transport: writes one file per (key, seq); same-key calls don't overwrite", async () => {
  const dir = tmpDir("record-multi");
  let count = 0;
  const fakeInner: Transport = {
    async request() {
      count += 1;
      return { status: 200, body: { call: count }, headers: { "content-type": "application/json" } };
    },
  };
  const recorder = makeRecordingTransport(dir, fakeInner);
  await recorder.request({ method: "GET", url: "https://api.github.com/x" });
  await recorder.request({ method: "GET", url: "https://api.github.com/x" });
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  assert.equal(files.length, 2, `expected 2 files, got ${files.join(",")}`);
});

test("replay transport: rejects transcript with bad method", () => {
  const dir = tmpDir("replay-validate-method");
  writeTranscript(dir, "01.json", {
    request: { method: "TRACE", url: "https://api.github.com/x", body: null },
    response: { status: 200, body: {}, headers: {} },
  });
  assert.throws(() => makeReplayTransport(dir), /method.*GET\|POST\|PATCH\|PUT\|DELETE/);
});

test("replay transport: rejects transcript with non-URL request", () => {
  const dir = tmpDir("replay-validate-url");
  writeTranscript(dir, "01.json", {
    request: { method: "GET", url: "not a url", body: null },
    response: { status: 200, body: {}, headers: {} },
  });
  assert.throws(() => makeReplayTransport(dir), /not a valid URL/);
});

test("replay transport: rejects transcript with out-of-range status", () => {
  const dir = tmpDir("replay-validate-status");
  writeTranscript(dir, "01.json", {
    request: { method: "GET", url: "https://api.github.com/x", body: null },
    response: { status: 999, body: {}, headers: {} },
  });
  assert.throws(() => makeReplayTransport(dir), /status.*\[100, 599\]/);
});

test("replay transport: rejects transcript missing required fields", () => {
  const dir = tmpDir("replay-validate-missing");
  writeTranscript(dir, "01.json", { response: { status: 200, body: {}, headers: {} } });
  assert.throws(() => makeReplayTransport(dir), /'request' must be an object/);
});

test("replay transport: error message redacts URL path (no repo PII)", async () => {
  const dir = tmpDir("replay-redact");
  // Empty corpus → every replay call misses.
  setTransportForTesting(makeReplayTransport(dir));
  try {
    let caught: unknown;
    try {
      await httpJson({ method: "GET", url: "https://api.github.com/repos/secret-org/private-repo" });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error);
    assert.ok(!caught.message.includes("secret-org"));
    assert.ok(!caught.message.includes("private-repo"));
    assert.ok(caught.message.includes("api.github.com"));
  } finally {
    setTransportForTesting(null);
  }
});

test("env selection: LBVD_HTTP_REPLAY=<dir> picks the replay transport", async () => {
  const dir = tmpDir("env-replay");
  writeTranscript(dir, "01.json", {
    request: { method: "GET", url: "https://api.github.com/x", body: null },
    response: { status: 200, body: { ok: 1 }, headers: {} },
  });
  const prev = process.env.LBVD_HTTP_REPLAY;
  process.env.LBVD_HTTP_REPLAY = dir;
  setTransportForTesting(null); // force re-read of env on next getTransport()
  try {
    const res = await httpJson({ method: "GET", url: "https://api.github.com/x" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: 1 });
  } finally {
    setTransportForTesting(null);
    if (prev === undefined) delete process.env.LBVD_HTTP_REPLAY;
    else process.env.LBVD_HTTP_REPLAY = prev;
  }
});

test("env selection: no env vars falls through to liveTransport (no actual call)", () => {
  const prev = process.env.LBVD_HTTP_REPLAY;
  delete process.env.LBVD_HTTP_REPLAY;
  setTransportForTesting(null);
  try {
    // We don't *invoke* the transport (would hit the network); we just verify
    // a Transport-shaped object is returned and is distinct from the replay
    // transport's frozen behavior.
    const t = getTransport();
    assert.equal(typeof t.request, "function");
  } finally {
    setTransportForTesting(null);
    if (prev !== undefined) process.env.LBVD_HTTP_REPLAY = prev;
  }
});

test("recording transport: cache key excludes Authorization header", async () => {
  // Two recordings with different auth headers but same (method, url, body)
  // collapse to a single key — proves the auth header isn't part of identity.
  const dir = tmpDir("record-auth");
  const fakeInner: Transport = {
    async request() {
      return { status: 200, body: {}, headers: {} };
    },
  };
  const recorder = makeRecordingTransport(dir, fakeInner);
  await recorder.request({
    method: "GET",
    url: "https://api.github.com/x",
    headers: { Authorization: "Bearer token-A" },
  });
  await recorder.request({
    method: "GET",
    url: "https://api.github.com/x",
    headers: { Authorization: "Bearer token-B" },
  });
  // Two transcripts written (different seq), same canonical key.
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  assert.equal(files.length, 2);
  // Both filenames share the same key suffix — verify that.
  const keyOf = (n: string): string => {
    const m = /_([0-9a-f]{16})(?:_\d+)?\.json$/.exec(n);
    return m !== null ? m[1]! : "";
  };
  assert.equal(keyOf(files[0]!), keyOf(files[1]!), "auth header must not affect cache key");
});
