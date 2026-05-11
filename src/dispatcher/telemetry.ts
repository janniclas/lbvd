import * as path from "node:path";
import { atomicWriteJson } from "./state.js";

export interface ActiveAgent {
  agent_id: string;
  target_file: string | null;
  stage: 1 | 2 | "probe";
  started_at: string;
  pid: number;
}

export interface ActiveFile {
  schema_version: 1;
  agents: ActiveAgent[];
}

export function activePath(runDir: string): string {
  return path.join(runDir, "active.json");
}

export function initActive(runDir: string): void {
  atomicWriteJson(activePath(runDir), { schema_version: 1, agents: [] });
}

export function truncateActive(runDir: string): void {
  initActive(runDir);
}

export function writeActive(runDir: string, agents: ActiveAgent[]): void {
  atomicWriteJson(activePath(runDir), { schema_version: 1, agents });
}
