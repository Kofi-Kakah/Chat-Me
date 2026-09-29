import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createApp, parseOrigins } from "./app";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { disconnectDatabase } from "./lib/prisma";
import { closeRedis, initRedis, isRedisEnabled, makeRedisClient } from "./lib/redis";
import { startPeriodicJobs, type PeriodicJobs } from "./jobs";
import { flushPresence } from "./realtime/presence.service";
import { setupRealtime } from "./realtime";
import type { ClientToServerEvents, ServerToClientEvents } from "./realtime/events";

export type ChatIo = Server<ClientToServerEvents, ServerToClientEvents>;

export interface ChatServer {
  httpServer: http.Server;
  io: ChatIo;
  /** Starts listening; returns the bound port (resolves port 0 to the actual port). */
  listen(port?: number): Promise<number>;
  shutdown(): Promise<void>;
}

export async function createChatServer(): Promise<ChatServer> {
  await initRedis();

  const app = createApp();
  const httpServer = http.createServer(app);

  const io: ChatIo = new Server(httpServer, {
    path: env.SOCKET_PATH,
    cors: {
      origin: parseOrigins(env.CLIENT_ORIGIN),
      credentials: true,
      methods: ["GET", "POST"],
    },
    maxHttpBufferSize: 1_000_000,
  });

  if (env.REDIS_URL) {
    try {
      const pub = makeRedisClient();
      const sub = makeRedisClient();
      const adapter = await createAdapter(pub, sub);
      io.adapter(adapter);
      logger.info("Socket.IO redis adapter enabled (multi-instance broadcasting)");
    } catch (error) {
      logger.warn("Redis adapter initialisation failed — running single-instance", {
        error: String(error),
      });
    }
  }

  setupRealtime(io);
  const jobs: PeriodicJobs = startPeriodicJobs();

  return {
    httpServer,
    io,
    listen(port: number = env.PORT) {
      return new Promise((resolve) => {
        httpServer.listen(port, () => {
          const address = httpServer.address() as AddressInfo;
          resolve(port === 0 ? address.port : port);
        });
      });
    },
    async shutdown(): Promise<void> {
      jobs.stop();
      await flushPresence(io);
      io.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      httpServer.closeAllConnections?.();
      await disconnectDatabase();
      if (isRedisEnabled()) await closeRedis();
      logger.info("Shutdown complete");
    },
  };
}
