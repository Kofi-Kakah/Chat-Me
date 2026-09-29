import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { env } from "../config/env";
import { logger } from "./logger";

/**
 * This process is long-lived and owns exactly one connection pool, so it prefers
 * the direct (unpooled) endpoint when one is configured. Routing every query
 * through a transaction-mode pooler adds a hop and lets the pooler recycle
 * connections underneath the driver, which surfaces mid-query as
 * "Connection terminated unexpectedly".
 */
const connectionString =
  env.DATABASE_URL_DIRECT ?? env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;

const pool = new pg.Pool({
  connectionString,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
  statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
  keepAlive: true,
  application_name: "chat-me-api",
});

// Emitted for idle clients the server dropped. `pg` evicts them from the pool,
// so this is recoverable and must never escape as an unhandled rejection.
pool.on("error", (error) => {
  logger.warn("Idle database connection dropped", { error: error.message });
});

const adapter = new PrismaPg(pool, {
  onPoolError: (error) => logger.warn("Database pool error", { error: error.message }),
  onConnectionError: (error) => logger.warn("Database connection error", { error: error.message }),
});

const prisma = new PrismaClient({ adapter });

/** Drains the client and its pool. Call once, after the final query. */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect().catch(() => undefined);
  await pool.end().catch(() => undefined);
}

export { prisma, pool };
