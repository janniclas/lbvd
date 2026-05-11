import { request as undiciRequest } from "undici";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface HttpResponse {
  status: number;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT = 30_000;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];
const VALID_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);

function shouldRetry(status: number): boolean {
  return status >= 500 || status === 429;
}

async function rawRequest(req: HttpRequest): Promise<HttpResponse> {
  const opts: Parameters<typeof undiciRequest>[1] = {
    method: req.method,
    headers: req.headers ?? {},
    bodyTimeout: req.timeoutMs ?? DEFAULT_TIMEOUT,
    headersTimeout: req.timeoutMs ?? DEFAULT_TIMEOUT,
  };
  if (req.body !== undefined) {
    opts.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }
  const res = await undiciRequest(req.url, opts);
  const text = await res.body.text();
  const headers = res.headers as unknown as Record<string, string | string[] | undefined>;
  let body: unknown = text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.statusCode, body, headers };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Strip path/query so the redacted message is safe to log. Hostnames are kept
 * (helpful for diagnostics); paths often contain repo names that are PII for
 * private orgs and should not propagate to stderr.
 */
function redactUrlPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

export interface Transport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

const liveTransport: Transport = {
  async request(req) {
    let lastErr: unknown = null;
    for (let i = 0; i <= RETRY_BACKOFF_MS.length; i += 1) {
      try {
        const res = await rawRequest(req);
        if (!shouldRetry(res.status)) return res;
        if (i === RETRY_BACKOFF_MS.length) return res;
      } catch (e) {
        lastErr = e;
        if (i === RETRY_BACKOFF_MS.length) throw e;
      }
      await delay(RETRY_BACKOFF_MS[i]!);
    }
    // Loop exits via early return or rethrow above; this is unreachable.
    throw lastErr instanceof Error ? lastErr : new Error("liveTransport: retry loop exited unexpectedly");
  },
};

interface Transcript {
  request: { method: string; url: string; body: unknown };
  response: HttpResponse;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function canonicalBody(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  return stableStringify(body);
}

/**
 * Match key for a transcript. The auth header is intentionally NOT part of the
 * key — recordings made with one token must replay against tests that have no
 * token at all. Two recordings made with different tokens collapse to the same
 * key; the recorder's per-key seq counter resolves multiple captures by writing
 * separate files (see `transcriptFilename`).
 */
function transcriptKey(method: string, url: string, body: unknown): string {
  const canonical = `${method.toUpperCase()}\n${url}\n${canonicalBody(body)}`;
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function urlSlug(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname + u.search).replace(/[^A-Za-z0-9]/g, "_").replace(/_+/g, "_").slice(0, 80);
  } catch {
    return url.replace(/[^A-Za-z0-9]/g, "_").slice(0, 80);
  }
}

function transcriptFilename(method: string, url: string, key: string, seq: number): string {
  // padStart(3) handles up to 999 same-key captures per scenario. If a future
  // scenario needs more, widen here — lexical sort breaks if seq exceeds the pad.
  const suffix = seq > 0 ? `_${String(seq).padStart(3, "0")}` : "";
  return `${method.toUpperCase()}${urlSlug(url)}_${key}${suffix}.json`;
}

/**
 * Validate a parsed transcript object. A malformed transcript would otherwise
 * pass through `JSON.parse(text) as Transcript` and surface as a confusing
 * `TypeError` deep inside the reporter's response handling. Validation here
 * runs once at corpus load time and bounds what the reporter can observe.
 */
function validateTranscript(t: unknown, fileName: string): Transcript {
  const ctx = `transcript ${fileName}`;
  if (t === null || typeof t !== "object") {
    throw new Error(`${ctx}: top-level must be an object`);
  }
  const root = t as Record<string, unknown>;
  if (root.request === null || typeof root.request !== "object") {
    throw new Error(`${ctx}: 'request' must be an object`);
  }
  if (root.response === null || typeof root.response !== "object") {
    throw new Error(`${ctx}: 'response' must be an object`);
  }
  const req = root.request as Record<string, unknown>;
  if (typeof req.method !== "string" || !VALID_METHODS.has(req.method)) {
    throw new Error(`${ctx}: 'request.method' must be one of GET|POST|PATCH|PUT|DELETE`);
  }
  if (typeof req.url !== "string" || req.url.length === 0) {
    throw new Error(`${ctx}: 'request.url' must be a non-empty string`);
  }
  try {
    new URL(req.url);
  } catch {
    throw new Error(`${ctx}: 'request.url' is not a valid URL`);
  }
  const resp = root.response as Record<string, unknown>;
  if (typeof resp.status !== "number" || !Number.isInteger(resp.status) || resp.status < 100 || resp.status > 599) {
    throw new Error(`${ctx}: 'response.status' must be an integer in [100, 599]`);
  }
  if (resp.headers === null || typeof resp.headers !== "object") {
    throw new Error(`${ctx}: 'response.headers' must be an object`);
  }
  return {
    request: { method: req.method, url: req.url, body: req.body ?? null },
    response: { status: resp.status, body: resp.body, headers: resp.headers as HttpResponse["headers"] },
  };
}

/**
 * Same (method, url, body) can repeat with different responses (e.g. a search
 * call returns "miss" before openIssue and "hit" after). Files are loaded in
 * filename-sorted order, appended per key, and consumed in order at replay.
 */
function loadCorpus(dir: string): Map<string, Transcript[]> {
  const map = new Map<string, Transcript[]>();
  if (!fs.existsSync(dir)) return map;
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    const raw: unknown = JSON.parse(text);
    const t = validateTranscript(raw, name);
    const key = transcriptKey(t.request.method, t.request.url, t.request.body);
    let list = map.get(key);
    if (list === undefined) {
      list = [];
      map.set(key, list);
    }
    list.push(t);
  }
  return map;
}

export function makeReplayTransport(corpusDir: string): Transport {
  const corpus = loadCorpus(corpusDir);
  const consumed = new Map<string, number>();
  return {
    async request(req) {
      const key = transcriptKey(req.method, req.url, req.body);
      const list = corpus.get(key);
      if (list === undefined || list.length === 0) {
        throw new Error(
          `replay: no recorded transcript for ${req.method} ${redactUrlPath(req.url)} (key=${key})`,
        );
      }
      const idx = consumed.get(key) ?? 0;
      if (idx >= list.length) {
        throw new Error(
          `replay: transcript exhausted for ${req.method} ${redactUrlPath(req.url)} (key=${key}, ${list.length} recorded)`,
        );
      }
      consumed.set(key, idx + 1);
      return list[idx]!.response;
    },
  };
}

const KEPT_RESPONSE_HEADERS = new Set(["content-type"]);

function pickResponseHeaders(headers: HttpResponse["headers"]): HttpResponse["headers"] {
  const out: HttpResponse["headers"] = {};
  for (const [k, v] of Object.entries(headers)) {
    if (KEPT_RESPONSE_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Wraps an inner transport (default: live) and writes (request, response) to
 * disk. The inner transport is injectable so tests can record without hitting
 * the network.
 *
 * **Body-redaction discipline.** Response headers are stripped to a
 * content-type-only allowlist (see `KEPT_RESPONSE_HEADERS`). **Request bodies
 * and response bodies are persisted as-is.** The recorder must not be invoked
 * on a scenario whose bodies contain secrets — point it at a dedicated test
 * repo (see `scripts/setup-fixtures-repo.sh`). If the bodies grow to include
 * sensitive metadata in the future, add a body-stripping pass alongside
 * `pickResponseHeaders`.
 */
export function makeRecordingTransport(corpusDir: string, inner: Transport = liveTransport): Transport {
  fs.mkdirSync(corpusDir, { recursive: true });
  const seqByKey = new Map<string, number>();
  return {
    async request(req) {
      const res = await inner.request(req);
      const transcript: Transcript = {
        request: { method: req.method, url: req.url, body: req.body ?? null },
        response: { status: res.status, body: res.body, headers: pickResponseHeaders(res.headers) },
      };
      const key = transcriptKey(req.method, req.url, req.body);
      const seq = seqByKey.get(key) ?? 0;
      seqByKey.set(key, seq + 1);
      const filename = transcriptFilename(req.method, req.url, key, seq);
      fs.writeFileSync(
        path.join(corpusDir, filename),
        JSON.stringify(transcript, null, 2) + "\n",
      );
      return res;
    },
  };
}

let _transport: Transport | null = null;

/**
 * Build the production transport from environment.
 *
 * - `LBVD_HTTP_REPLAY=<dir>` → replay transport against the given corpus.
 * - otherwise → live transport.
 *
 * The recording transport is **not** selectable here. The recorder script
 * (`scripts/record-http.ts`) wires the recording transport directly via
 * `setTransportForTesting(makeRecordingTransport(...))`. Keeping recording
 * out of the env path means a runtime invocation cannot accidentally start
 * writing to a corpus directory; a misconfigured `LBVD_RECORD_HTTP=1`
 * has no effect on the dispatcher.
 */
function buildTransportFromEnv(): Transport {
  const replayDir = process.env.LBVD_HTTP_REPLAY;
  if (replayDir !== undefined && replayDir.length > 0) {
    return makeReplayTransport(replayDir);
  }
  return liveTransport;
}

export function getTransport(): Transport {
  if (_transport === null) {
    _transport = buildTransportFromEnv();
  }
  return _transport;
}

/**
 * Override the module's transport from a test. Pass a `Transport` to inject
 * a fake; pass `null` to clear the cache (the next `getTransport()` will
 * re-read env). Callers that want to assume "live" must clear the relevant
 * env vars themselves — `null` does NOT force live, it falls back to
 * `buildTransportFromEnv()`. This matters when `LBVD_HTTP_REPLAY` is
 * inherited from a parent shell.
 */
export function setTransportForTesting(t: Transport | null): void {
  _transport = t;
}

export async function httpJson(req: HttpRequest): Promise<HttpResponse> {
  const res = await getTransport().request(req);
  if (res.status >= 400) {
    throw new HttpError(
      `${req.method} ${redactUrlPath(req.url)}: ${res.status}`,
      res.status,
      res.body,
    );
  }
  return res;
}
