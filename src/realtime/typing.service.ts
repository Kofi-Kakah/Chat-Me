import type { Server } from "socket.io";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import type { TypingUpdate } from "../lib/mappers";
import { prisma } from "../lib/prisma";
import { getStore, prefixed } from "../lib/redis";
import { ROOM, S2C, type ClientToServerEvents, type ServerToClientEvents } from "./events";

type ChatServer = Server<ClientToServerEvents, ServerToClientEvents>;

/**
 * Expiry timers for typing sessions owned by *this* process, keyed by
 * `conversationId:userId`, plus the set of conversations each socket is
 * currently typing in (so a dropped socket can be cleaned up).
 *
 * The store key is what makes typing visible across instances, but nothing
 * removes it when a client simply stops sending events — tab closed, network
 * dropped, process killed. Without a timer peers would be left showing
 * "typing…" until their own client-side timeout gave up. The stop event is
 * emitted through Socket.IO, so with the redis adapter fitted it reaches peers
 * on every instance, and only the instance owning the socket needs a timer.
 */
const expiryTimers = new Map<string, NodeJS.Timeout>();
const socketConversations = new Map<string, Set<string>>();

function sessionKey(conversationId: string, userId: string): string {
  return `${conversationId}:${userId}`;
}

function typingKey(conversationId: string, userId: string): string {
  return prefixed(`typing:${conversationId}:${userId}`);
}

function clearExpiry(conversationId: string, userId: string): void {
  const key = sessionKey(conversationId, userId);
  const timer = expiryTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  expiryTimers.delete(key);
}

function scheduleExpiry(
  io: ChatServer,
  conversationId: string,
  userId: string,
  socketId: string,
): void {
  clearExpiry(conversationId, userId);
  const timer = setTimeout(() => {
    expiryTimers.delete(sessionKey(conversationId, userId));
    void expireTyping(io, conversationId, userId, socketId);
  }, env.TYPING_TTL_SECONDS * 1000);
  timer.unref();
  expiryTimers.set(sessionKey(conversationId, userId), timer);
}

function trackSocketConversation(socketId: string, conversationId: string, typing: boolean): void {
  if (!typing) {
    socketConversations.get(socketId)?.delete(conversationId);
    return;
  }
  const existing = socketConversations.get(socketId);
  if (existing) existing.add(conversationId);
  else socketConversations.set(socketId, new Set([conversationId]));
}

function emitTyping(
  io: ChatServer,
  conversationId: string,
  userId: string,
  isTyping: boolean,
  socketId: string,
): void {
  const payload: TypingUpdate = { conversationId, userId, isTyping };
  io.to(ROOM.conversation(conversationId)).except(socketId).emit(S2C.typingUpdate, payload);
}

/**
 * Marks a user typing/not typing in a conversation. Repeated "start" events
 * refresh the window (a long message keeps a user typing) but are not
 * re-broadcast, so the room is not spammed.
 */
export async function setTyping(
  io: ChatServer,
  socketId: string,
  conversationId: string,
  userId: string,
  isTyping: boolean,
): Promise<void> {
  const store = getStore();
  const key = typingKey(conversationId, userId);

  if (isTyping) {
    const first = await store.setNxEx(key, "1", env.TYPING_TTL_SECONDS);
    if (first) {
      persistTyping(conversationId, userId, true);
    } else {
      // Already typing: extend rather than let the window lapse mid-keystroke.
      await store.expire(key, env.TYPING_TTL_SECONDS).catch(() => undefined);
    }
    trackSocketConversation(socketId, conversationId, true);
    scheduleExpiry(io, conversationId, userId, socketId);
    if (!first) return;
  } else {
    clearExpiry(conversationId, userId);
    trackSocketConversation(socketId, conversationId, false);
    await store.del(key);
    persistTyping(conversationId, userId, false);
  }

  emitTyping(io, conversationId, userId, isTyping, socketId);
}

/** Fires when a typing window lapses with no explicit stop event. */
async function expireTyping(
  io: ChatServer,
  conversationId: string,
  userId: string,
  socketId: string,
): Promise<void> {
  try {
    await getStore().del(typingKey(conversationId, userId));
    persistTyping(conversationId, userId, false);
    emitTyping(io, conversationId, userId, false, socketId);
  } catch (error) {
    logger.warn("Typing expiry failed", { conversationId, userId, error: String(error) });
  }
}

/** Clears every typing state held by a socket that has just disconnected. */
export async function clearTypingForSocket(
  io: ChatServer,
  socketId: string,
  userId: string,
): Promise<void> {
  const conversations = socketConversations.get(socketId);
  socketConversations.delete(socketId);
  if (!conversations || conversations.size === 0) return;

  for (const conversationId of conversations) {
    clearExpiry(conversationId, userId);
    await getStore()
      .del(typingKey(conversationId, userId))
      .catch(() => undefined);
    persistTyping(conversationId, userId, false);
    emitTyping(io, conversationId, userId, false, socketId);
  }
}

/** Best-effort persistence into the ephemeral TypingStatus table. */
function persistTyping(conversationId: string, userId: string, isTyping: boolean): void {
  if (isTyping) {
    const expiresAt = new Date(Date.now() + env.TYPING_TTL_SECONDS * 1000);
    prisma.typingStatus
      .upsert({
        where: { conversationId_userId: { conversationId, userId } },
        create: { conversationId, userId, expiresAt },
        update: { expiresAt },
      })
      .catch((error) => logger.warn("TypingStatus upsert failed", { error: String(error) }));
  } else {
    prisma.typingStatus
      .deleteMany({ where: { conversationId, userId } })
      .catch(() => undefined);
  }
}

/** Deletes stale TypingStatus rows (run periodically). */
export function cleanupExpiredTyping(): Promise<number> {
  return prisma.typingStatus
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .then((result) => result.count)
    .catch(() => 0);
}
