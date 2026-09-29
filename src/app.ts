import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { isRedisEnabled } from "./lib/redis";
import { createRateLimit } from "./middleware/rate-limit";
import { errorHandler, notFoundHandler } from "./middleware/error";
import authRoutes from "./modules/auth/auth.routes";
import usersRoutes from "./modules/users/users.routes";
import conversationsRoutes from "./modules/conversations/conversations.routes";
import messagesRoutes from "./modules/messages/messages.routes";
import notificationsRoutes from "./modules/notifications/notifications.routes";

export function parseOrigins(value: string): true | string[] {
  if (value === "*") return true;
  const list = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? list : true;
}

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: parseOrigins(env.CLIENT_ORIGIN), credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(httpRequestLogger);

  // Liveness probe (not rate limited).
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      mode: isRedisEnabled() ? "redis" : "memory",
    });
  });

  app.use(createRateLimit({ scope: "api" }));

  app.use("/api/auth", authRoutes);
  app.use("/api/users", usersRoutes);
  app.use("/api/conversations", conversationsRoutes);
  app.use("/api/messages", messagesRoutes);
  app.use("/api/notifications", notificationsRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function httpRequestLogger(req: Request, res: Response, next: () => void): void {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    logger.debug("http", {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });
  next();
}
