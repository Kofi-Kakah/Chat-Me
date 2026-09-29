import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { logger } from "../lib/logger";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: "not_found",
      message: `Route ${req.method} ${req.path} does not exist`,
    },
  });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: "validation_error",
        message: "Invalid request payload",
        details: err.issues,
      },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      res.status(409).json({ error: { code: "conflict", message: "Resource already exists" } });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({ error: { code: "not_found", message: "Resource not found" } });
      return;
    }
  }

  logger.error(`Unhandled error on ${req.method} ${req.path}`, {
    error: err instanceof Error ? err.stack : String(err),
  });
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong" } });
}
