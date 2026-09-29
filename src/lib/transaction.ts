import { env } from "../config/env";

/**
 * Ceilings for interactive transactions.
 *
 * Prisma's defaults are tuned for a local database: it abandons a transaction
 * that cannot acquire a pooled connection within `maxWait` (2s). A remote
 * database — Neon in particular, which suspends idle compute between bursts —
 * can take longer than that to hand out a fresh connection, which surfaced as
 * "Unable to start a transaction in the given time" on entirely healthy writes.
 *
 * The array form of `$transaction([...])` cannot be configured at all, so every
 * multi-statement write is expressed as an interactive transaction using these
 * ceilings. `timeout` is kept aligned with the server-side statement timeout so
 * a wedged transaction is always closed by whichever limit trips first.
 */
export const TRANSACTION_OPTIONS = {
  maxWait: Math.max(env.DB_CONNECT_TIMEOUT_MS, 10_000),
  timeout: env.DB_STATEMENT_TIMEOUT_MS,
} as const;
