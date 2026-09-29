import type { Server } from "socket.io";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import type { PresenceUpdate } from "../lib/mappers";
import { prisma } from "../lib/prisma";
import { getStore, prefixed } from "../lib/redis";
import { ROOM, S2C, type ClientToServerEvents, type ServerToClientEvents } from "./events";

type ChatServer = Server<ClientToServerEvents, ServerToClientEvents>;


const PRESENCE_COUNT_TTL = 60 * 60; // 1h, refreshed on connect + heartbeats
const CONTACTS_CACHE_TTL = 60;

const pendingOffline = new Map<string, NodeJS.Timeout>();

function countKey(userId: string): string {
  return prefixed(`presence:count:${userId}`);
}

function contactsKey(userId: string): string {
  return prefixed(`contacts:${userId}`);
}

/** Called when a socket for the user connects (any instance). */
export async function onConnect(io: ChatServer, userId: string): Promise<void> {
  cancelPendingOffline(userId);
  const count = await getStore().incr(countKey(userId), PRESENCE_COUNT_TTL);
  if (count === 1) {
    try {
      await prisma.user.update({ where: { id: userId }, data: { isOnline: true } });
    } catch (error) {
      logger.warn("Failed to mark user online", { userId, error: String(error) });
    }
    await broadcastPresence(io, userId, true);
  }
}

/** Keeps the presence counter TTL alive while the user is connected. */
export async function touch(userId: string): Promise<void> {
  try {
    await getStore().expire(countKey(userId), PRESENCE_COUNT_TTL);
  } catch {
    // Non-fatal: the TTL only guards against leaks across restarts.
  }
}

/** Called when a socket for the user disconnects (any instance). */
export async function onDisconnect(io: ChatServer, userId: string): Promise<void> {
  const count = await getStore().decr(countKey(userId));
  if (count > 0) return;
  scheduleOffline(io, userId);
}

function scheduleOffline(io: ChatServer, userId: string): void {
  cancelPendingOffline(userId);
  const timer = setTimeout(() => {
    void confirmOffline(io, userId);
  }, env.PRESENCE_GRACE_SECONDS * 1000);
  pendingOffline.set(userId, timer);
}

function cancelPendingOffline(userId: string): void {
  const timer = pendingOffline.get(userId);
  if (timer) {
    clearTimeout(timer);
    pendingOffline.delete(userId);
  }
}

async function confirmOffline(io: ChatServer, userId: string): Promise<void> {
  pendingOffline.delete(userId);
  try {
    const count = await getStore().get(countKey(userId));
    if (count !== null && Number(count) > 0) return; // reconnected elsewhere

    await getStore().del(countKey(userId));
    const lastSeenAt = new Date();
    await prisma.user
      .update({ where: { id: userId }, data: { isOnline: false, lastSeenAt } })
      .catch((error) => logger.warn("Failed to mark user offline", { userId, error: String(error) }));
    await broadcastPresence(io, userId, false);
  } catch (error) {
    logger.warn("Presence offline handling failed", { userId, error: String(error) });
  }
}

/** Broadcasts a presence update to everyone sharing a conversation with the user. */
export async function broadcastPresence(
  io: ChatServer,
  userId: string,
  isOnline: boolean,
): Promise<void> {
  const payload: PresenceUpdate = {
    userId,
    isOnline,
    lastSeenAt: isOnline ? null : new Date().toISOString(),
  };
  const contacts = await getContactIds(userId);
  const rooms = [...new Set([...contacts, userId])].map((id) => ROOM.user(id));
  io.to(rooms).emit(S2C.presenceUpdate, payload);
}

async function getContactIds(userId: string): Promise<string[]> {
  const store = getStore();
  try {
    const cached = await store.get(contactsKey(userId));
    if (cached !== null) return JSON.parse(cached) as string[];
  } catch {
    // Cache miss/corruption: fall through to a fresh query.
  }

  const memberships = await prisma.conversationMember.findMany({
    where: { userId, leftAt: null },
    select: {
      conversation: {
        select: {
          members: {
            where: { leftAt: null, userId: { not: userId } },
            select: { userId: true },
          },
        },
      },
    },
  });

  const ids = [
    ...new Set(memberships.flatMap((m) => m.conversation.members.map((member) => member.userId))),
  ];
  await store
    .setEx(contactsKey(userId), JSON.stringify(ids), CONTACTS_CACHE_TTL)
    .catch(() => undefined);
  return ids;
}

export async function invalidateContactsCache(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await getStore().del(...userIds.map(contactsKey)).catch(() => undefined);
}

/**
 * Current presence of everyone who shares a conversation with this user. Sent to
 * a client as soon as its socket connects: the incremental `presence:update`
 * events only describe changes, so a client that has just connected has no other
 * way to learn who was already online before it arrived.
 */
export async function getContactPresence(userId: string): Promise<PresenceUpdate[]> {
  const contactIds = await getContactIds(userId);
  if (contactIds.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: contactIds } },
    select: { id: true, isOnline: true, lastSeenAt: true },
  });

  return users.map((user) => ({
    userId: user.id,
    isOnline: user.isOnline,
    lastSeenAt: user.lastSeenAt ? user.lastSeenAt.toISOString() : null,
  }));
}

/**
 * Marks every locally connected user offline — used during graceful shutdown.
 *
 * The presence counters must be cleared alongside the database flags. They carry
 * a one-hour TTL, so a counter left behind would make the next process to start
 * read a count above zero, skip its "came online" branch, and leave a genuinely
 * connected user marked offline for the rest of that hour.
 */
export async function flushPresence(io: ChatServer): Promise<void> {
  for (const userId of [...pendingOffline.keys()]) cancelPendingOffline(userId);

  const userIds = [...new Set([...io.sockets.sockets.values()].map((s) => s.data.userId))];
  if (userIds.length === 0) return;

  await getStore()
    .del(...userIds.map(countKey))
    .catch((error) => logger.warn("Failed to clear presence counters", { error: String(error) }));

  const lastSeenAt = new Date();
  await prisma.user
    .updateMany({ where: { id: { in: userIds } }, data: { isOnline: false, lastSeenAt } })
    .catch((error) => logger.warn("Failed to mark users offline", { error: String(error) }));

  for (const userId of userIds) {
    // Best-effort: the database and the counters are already correct, so a
    // failed broadcast only means peers find out on their next read instead.
    await broadcastPresence(io, userId, false).catch(() => undefined);
  }
}
