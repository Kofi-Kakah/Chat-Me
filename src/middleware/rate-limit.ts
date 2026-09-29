import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

// Periodically drop empty buckets so the map does not grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    bucket.hits = bucket.hits.filter((t) => now - t < env.RATE_LIMIT_WINDOW_MS);
    if (bucket.hits.length === 0) buckets.delete(key);
  }
}, 60_000).unref();

export interface RateLimitOptions {
  /** Logical scope, e.g. "api" or "auth". Combined with the client IP. */
  scope: string;
  max?: number;
  windowMs?: number;
}

/**
 * Fixed-window rate limiter. In-memory per instance; for multi-instance
 * deployments move the counters into Redis (or front the service with a
 * gateway that rate-limits).
 */
export function createRateLimit(options: RateLimitOptions) {
  const windowMs = options.windowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const max = options.max ?? env.RATE_LIMIT_MAX;

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const key = `${options.scope}:${req.ip ?? "unknown"}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      buckets.set(key, bucket);
    }

    bucket.hits = bucket.hits.filter((t) => now - t < windowMs);

    if (bucket.hits.length >= max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - bucket.hits[0])) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: { code: "rate_limited", message: "Too many requests, please slow down" },
      });
      return;
    }

    bucket.hits.push(now);
    next();
  };
}
