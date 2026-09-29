import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Optional direct (unpooled) endpoint. A long-lived server process owns its
  // own connection pool, so the direct endpoint keeps PgBouncer off the hot
  // path — and with it PgBouncer's idle-connection recycling, which otherwise
  // surfaces as "Connection terminated unexpectedly" on an in-flight query.
  DATABASE_URL_DIRECT: z.string().min(1).optional(),
  // Neon labels the same direct endpoint DATABASE_URL_UNPOOLED; accepted as an
  // alias so an existing Neon .env works without edits.
  DATABASE_URL_UNPOOLED: z.string().min(1).optional(),
  // Optional. When set, Redis powers the Socket.IO redis adapter, presence and
  // typing coordination across instances. When omitted, the server runs in
  // single-instance mode with an in-memory store.
  REDIS_URL: z.string().min(1).optional(),
  CLIENT_ORIGIN: z.string().default("*"),
  SOCKET_PATH: z.string().default("/socket.io"),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  PRESENCE_GRACE_SECONDS: z.coerce.number().int().min(0).max(120).default(12),
  TYPING_TTL_SECONDS: z.coerce.number().int().min(2).max(60).default(6),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(240),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(15),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Connection-pool tuning. A statement timeout keeps one wedged query from
  // pinning a pool slot (and its HTTP request) open forever.
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  // Held well above the gap between typical bursts so the pool does not keep
  // re-paying the remote database's connection-setup cost.
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
