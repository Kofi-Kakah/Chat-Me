import { createHash, randomBytes } from "node:crypto";
import { env } from "../config/env";
import { prisma } from "./prisma";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Opaque session tokens are stored hashed (sha256) in the Session table, so a
 * database leak never exposes usable tokens and sessions remain revocable.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export async function createSession(userId: string): Promise<CreatedSession> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * DAY_MS);
  await prisma.session.create({
    data: { tokenHash: hashToken(token), userId, expiresAt },
  });
  return { token, expiresAt };
}

export async function resolveSession(token: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    // Lazily remove expired sessions on sight.
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  return session;
}
