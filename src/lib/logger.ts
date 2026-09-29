import { env, isProduction } from "../config/env";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogMeta = Record<string, unknown>;

function write(level: LogLevel, message: string, meta?: LogMeta): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[env.LOG_LEVEL]) return;
  const timestamp = new Date().toISOString();
  if (isProduction) {
    const line = JSON.stringify({ timestamp, level, message, ...(meta ?? {}) });
    (level === "error" ? console.error : console.log)(line);
  } else {
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    (level === "error" ? console.error : console.log)(`${timestamp} [${level}] ${message}${suffix}`);
  }
}

export const logger = {
  debug: (message: string, meta?: LogMeta) => write("debug", message, meta),
  info: (message: string, meta?: LogMeta) => write("info", message, meta),
  warn: (message: string, meta?: LogMeta) => write("warn", message, meta),
  error: (message: string, meta?: LogMeta) => write("error", message, meta),
};
