import { createHash } from "node:crypto";

export interface FingerprintInput {
  category: string;
  snippet: string;
}

export function fingerprint(input: FingerprintInput): string {
  const norm = normalizeSnippet(input.snippet);
  return createHash("sha256")
    .update(`${input.category}\n${norm}`)
    .digest("hex")
    .slice(0, 12);
}

export function infraNamespace(fp: string): string {
  return `${fp}:infra`;
}

const LINE_COMMENT = /(^|[^:])(\/\/[^\n]*|#[^\n]*)/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const WS = /\s+/g;

export function normalizeSnippet(s: string): string {
  let out = s.replace(BLOCK_COMMENT, "");
  out = out.replace(LINE_COMMENT, (_m, prefix: string) => prefix);
  out = out.replace(WS, " ");
  return out.trim();
}
