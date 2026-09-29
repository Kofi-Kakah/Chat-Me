import { env } from "./config/env";
import { logger } from "./lib/logger";
import { createChatServer } from "./server";

const chat = await createChatServer();
const port = await chat.listen();
logger.info(`Chat-Me API listening on port ${port} (socket path: ${env.SOCKET_PATH})`);

let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal} — shutting down`);
  try {
    await chat.shutdown();
  } finally {
    process.exit(exitCode);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", {
    reason: reason instanceof Error ? reason.stack : String(reason),
  });
});
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error: error.stack ?? String(error) });
  void shutdown("uncaughtException", 1);
});
