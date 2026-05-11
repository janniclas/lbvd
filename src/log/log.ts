import * as fs from "node:fs";
import { redact as defaultRedact, type Redactor } from "../redaction/redact.js";
import type { Clock } from "../clock/clock.js";

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

interface LoggerOpts {
  runId: string;
  debugFilePath?: string;
  clock: Clock;
  redactor?: Redactor;
}

interface LoggerState {
  baseFields: Record<string, unknown>;
  debugFile: number | null;
  clock: Clock;
  redact: (s: string) => string;
}

function emit(
  state: LoggerState,
  level: "INFO" | "DEBUG",
  event: string,
  fields: Record<string, unknown> | undefined,
): void {
  const ts = state.clock.now().toISOString();
  const record = {
    ts,
    level,
    event,
    ...state.baseFields,
    ...(fields ?? {}),
  };
  const line = state.redact(JSON.stringify(record)) + "\n";
  if (level === "INFO") {
    process.stdout.write(line);
  }
  if (state.debugFile !== null) {
    fs.writeSync(state.debugFile, line);
  }
}

function makeFromState(state: LoggerState): Logger {
  return {
    info(event, fields): void {
      emit(state, "INFO", event, fields);
    },
    debug(event, fields): void {
      emit(state, "DEBUG", event, fields);
    },
    child(fields): Logger {
      return makeFromState({ ...state, baseFields: { ...state.baseFields, ...fields } });
    },
  };
}

export function makeLogger(opts: LoggerOpts): Logger {
  let debugFile: number | null = null;
  if (opts.debugFilePath !== undefined) {
    debugFile = fs.openSync(opts.debugFilePath, "a");
  }
  const redactFn = opts.redactor !== undefined ? opts.redactor.redact : defaultRedact;
  const state: LoggerState = {
    baseFields: { run_id: opts.runId },
    debugFile,
    clock: opts.clock,
    redact: redactFn,
  };
  return makeFromState(state);
}

export const nullLogger: Logger = {
  info(): void {},
  debug(): void {},
  child(): Logger {
    return nullLogger;
  },
};
