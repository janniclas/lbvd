export function branchName(tier: 1 | 2, fingerprint: string): string {
  const prefix = tier === 1 ? "exploit" : "test";
  return `lbvd/${prefix}/${fingerprint}`;
}
