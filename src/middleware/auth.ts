import type { NextFunction, Request, Response } from "express";
import { toPublicUser, type PublicUser } from "../lib/mappers";
import { resolveSession } from "../lib/tokens";
import { ApiError, asyncHandler } from "./error";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
      sessionId?: string;
    }
  }
}

export const requireAuth = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token =
      header && header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
    if (!token) {
      throw new ApiError(401, "unauthorized", "Missing bearer token");
    }

    const session = await resolveSession(token);
    if (!session) {
      throw new ApiError(401, "unauthorized", "Invalid or expired session");
    }

    req.user = toPublicUser(session.user);
    req.sessionId = session.id;
    next();
  },
);
