export const REDACTION_PATTERNS: RegExp[] = [
  /\bgh[poesu]_[A-Za-z0-9]{36,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\boat_[A-Za-z0-9_-]{20,}\b/g, // CLAUDE_CODE_OAUTH_TOKEN prefix (sec M1/L3); literal-mask is still primary, this is the floor for paths that miss the literal.
  /\bxox[bpoa]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /Authorization:\s*Bearer\s+\S+/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /([A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z_]*\s*[:=]\s*)["']?[^"'\s]+/g,
];

export const REDACTED = "<redacted>";
