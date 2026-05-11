export type Substrate = "web-sandbox" | "diy-cloud";

export function detectSubstrate(env: NodeJS.ProcessEnv): Substrate {
  if (env["LBVD_SUBSTRATE"] === "web-sandbox") return "web-sandbox";
  return "diy-cloud";
}
