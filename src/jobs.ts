import { prisma } from "./lib/prisma";
import { logger } from "./lib/logger";
import { cleanupExpiredTyping } from "./realtime/typing.service";

export interface PeriodicJobs {
  stop(): void;
}

/**
 * Background maintenance:
 * - typing rows are ephemeral; stale rows are swept every 30s
 * - expired sessions are purged hourly
 */
export function startPeriodicJobs(): PeriodicJobs {
  const typing = setInterval(() => {
    void cleanupExpiredTyping();
  }, 30_000);
  typing.unref();

  const sessions = setInterval(() => {
    void prisma.session
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .catch((error) => logger.warn("Session cleanup failed", { error: String(error) }));
  }, 60 * 60 * 1000);
  sessions.unref();

  logger.info("Periodic jobs started");
  return {
    stop() {
      clearInterval(typing);
      clearInterval(sessions);
    },
  };
}
