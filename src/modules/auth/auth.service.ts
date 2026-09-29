import type { z } from "zod";
import { PUBLIC_USER_SELECT, toPublicUser, type PublicUser } from "../../lib/mappers";
import { hashPassword, verifyPassword } from "../../lib/password";
import { prisma } from "../../lib/prisma";
import { emitBus } from "../../lib/realtime-bus";
import { createSession } from "../../lib/tokens";
import { ApiError } from "../../middleware/error";
import type { LoginInput, RegisterInput } from "./auth.schemas";

export interface AuthResult {
  user: PublicUser;
  token: string;
  expiresAt: Date;
}

export async function registerUser(input: RegisterInput): Promise<AuthResult> {
  const email = input.email.toLowerCase().trim();
  const username = input.username.toLowerCase().trim();

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
    select: { email: true, username: true },
  });
  if (existing) {
    if (existing.email === email) {
      throw new ApiError(409, "email_taken", "An account with this email already exists");
    }
    throw new ApiError(409, "username_taken", "This username is already taken");
  }

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      email,
      username,
      passwordHash,
      displayName: input.displayName ?? null,
    },
  });

  const session = await createSession(user.id);
  return { user: toPublicUser(user), token: session.token, expiresAt: session.expiresAt };
}

export async function loginUser(input: LoginInput): Promise<AuthResult> {
  const identifier = input.identifier.toLowerCase().trim();
  const user = await prisma.user.findFirst({
    where: identifier.includes("@") ? { email: identifier } : { username: identifier },
  });
  if (!user) {
    throw new ApiError(401, "invalid_credentials", "Invalid credentials");
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
    throw new ApiError(401, "invalid_credentials", "Invalid credentials");
  }

  const session = await createSession(user.id);
  return { user: toPublicUser(user), token: session.token, expiresAt: session.expiresAt };
}

export async function logoutUser(sessionId: string): Promise<void> {
  await prisma.session.delete({ where: { id: sessionId } });
  emitBus("session:revoked", { sessionId });
}

export async function getCurrentUser(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: PUBLIC_USER_SELECT,
  });
  if (!user) throw new ApiError(404, "user_not_found", "User not found");
  return toPublicUser(user);
}
