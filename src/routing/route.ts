export type Tier = 1 | 2 | 3;
export type Severity = "low" | "medium" | "high";
export type Priority = "low" | "medium" | "high";

export interface RoutingResult {
  branch: boolean;
  priority: Priority;
  basePriority: Priority;
  bumpReason: string;
}

const T2_BUMP =
  "base medium → high because severity_self_rated=high";

function routeTier1(): RoutingResult {
  return { branch: true, priority: "high", basePriority: "high", bumpReason: "none" };
}

function routeTier2(severity: Severity): RoutingResult {
  if (severity === "high") {
    return { branch: true, priority: "high", basePriority: "medium", bumpReason: T2_BUMP };
  }
  return { branch: true, priority: "medium", basePriority: "medium", bumpReason: "none" };
}

function routeTier3(severity: Severity): RoutingResult {
  if (severity === "high") {
    return {
      branch: false,
      priority: "medium",
      basePriority: "low",
      bumpReason: "base low → medium because severity_self_rated=high",
    };
  }
  if (severity === "medium") {
    return {
      branch: false,
      priority: "medium",
      basePriority: "low",
      bumpReason: "base low → medium because severity_self_rated=medium",
    };
  }
  return { branch: false, priority: "low", basePriority: "low", bumpReason: "none" };
}

export function route(tier: Tier, severity: Severity): RoutingResult {
  switch (tier) {
    case 1:
      return routeTier1();
    case 2:
      return routeTier2(severity);
    case 3:
      return routeTier3(severity);
  }
}
