import { ZodError } from "zod";
import type { Socket, Server } from "socket.io";
import { assertActiveMembership } from "../modules/conversations/conversations.service";
import {
  readReceiptSchema,
  receiptSchema,
  sendMessageSchema,
  typingEventSchema,
} from "../modules/messages/messages.schemas";
import * as messagesService from "../modules/messages/messages.service";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { onBus } from "../lib/realtime-bus";
import { resolveSession } from "../lib/tokens";
import { ApiError } from "../middleware/error";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketAck,
  SocketAckFailure,
} from "./events";
import { C2S, ROOM, S2C } from "./events";
import * as presence from "./presence.service";
import * as typingService from "./typing.service";

type ChatServer = Server<ClientToServerEvents, ServerToClientEvents>;
type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

function toAckError(error: unknown): SocketAckFailure {
  if (error instanceof ApiError) {
    return {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    };
  }
  if (error instanceof ZodError) {
    return {
      ok: false,
      error: { code: "validation_error", message: "Invalid payload", details: error.issues },
    };
  }
  logger.error("Socket handler error", {
    error: error instanceof Error ? error.stack : String(error),
  });
  return {
    ok: false,
    error: { code: "internal_error", message: "Something went wrong" },
  };
}

// Temporarily verbose: surface every ack failure path while validating.
function ackErr(error: unknown): SocketAckFailure {
  const result = toAckError(error);
  logger.warn("socket ack error", { error: result.error });
  return result;
}

function extractToken(socket: ChatSocket): string | null {
  const auth = socket.handshake.auth as Record<string, unknown> | undefined;
  const fromAuth = typeof auth?.token === "string" ? auth.token.trim() : null;
  if (fromAuth) return fromAuth;
  const header = socket.handshake.headers.authorization;
  return header && header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

/** Joins the conversation room for this socket if (and only if) still a member. */
async function ensureConversationRoom(
  socket: ChatSocket,
  conversationId: string,
): Promise<boolean> {
  if (socket.data.convIds.has(conversationId)) return true;
  try {
    await assertActiveMembership(socket.data.userId, conversationId);
  } catch {
    return false;
  }
  socket.data.convIds.add(conversationId);
  socket.join(ROOM.conversation(conversationId));
  return true;
}

export function setupRealtime(io: ChatServer): void {
  io.use(async (socket, next) => {
    try {
      const token = extractToken(socket);
      if (!token) return next(new Error("unauthorized: missing session token"));
      const session = await resolveSession(token);
      if (!session) return next(new Error("unauthorized: invalid or expired session"));
      socket.data.userId = session.user.id;
      socket.data.sessionId = session.id;
      socket.data.username = session.user.username;
      socket.data.convIds = new Set();
      next();
    } catch (error) {
      next(error instanceof Error ? error : new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    void handleConnection(io, socket);
  });

  subscribeBus(io);
  logger.info("Realtime layer initialised");
}

async function handleConnection(io: ChatServer, socket: ChatSocket): Promise<void> {
  const userId = socket.data.userId;

  socket.join(ROOM.user(userId));
  socket.join(ROOM.session(socket.data.sessionId));

  try {
    const memberships = await prisma.conversationMember.findMany({
      where: { userId, leftAt: null },
      select: { conversationId: true },
    });
    for (const membership of memberships) {
      socket.data.convIds.add(membership.conversationId);
      socket.join(ROOM.conversation(membership.conversationId));
    }

    // Both of these are per-connection catch-up that the incremental event
    // stream cannot express: who was already online before this client arrived,
    // and which messages were produced while it was away. They are independent,
    // so they run together.
    const [contacts] = await Promise.all([
      presence.getContactPresence(userId),
      messagesService.markPendingDelivered(userId),
    ]);
    socket.emit(S2C.presenceSnapshot, { users: contacts });

    await presence.onConnect(io, userId);
  } catch (error) {
    logger.error("Socket connection setup failed", { userId, error: String(error) });
  }

  registerHandlers(io, socket);

  socket.on("disconnect", () => {
    void presence.onDisconnect(io, userId);
    // A socket that vanishes mid-sentence must not leave the conversation
    // showing "typing…".
    void typingService.clearTypingForSocket(io, socket.id, userId);
  });
}

function registerHandlers(io: ChatServer, socket: ChatSocket): void {
  socket.on(C2S.messageSend, async (payload, ack) => {
    try {
      const input = sendMessageSchema.parse(payload ?? {});
      if (!(await ensureConversationRoom(socket, input.conversationId))) {
        throw new ApiError(404, "conversation_not_found", "Conversation not found");
      }
      const actor = {
        id: socket.data.userId,
        username: socket.data.username,
        displayName: null,
        avatarUrl: null,
      };
      const message = await messagesService.sendMessage(actor, input.conversationId, input);
      ack?.({ ok: true, data: message });
    } catch (error) {
      ack?.(ackErr(error));
    }
  });

  socket.on(C2S.messageDelivered, async (payload, ack) => {
    try {
      const input = receiptSchema.parse(payload ?? {});
      if (!(await ensureConversationRoom(socket, input.conversationId))) {
        throw new ApiError(404, "conversation_not_found", "Conversation not found");
      }
      const receipt = await messagesService.markDelivered(
        socket.data.userId,
        input.conversationId,
        input.messageIds,
      );
      ack?.({ ok: true, data: receipt });
    } catch (error) {
      ack?.(toAckError(error));
    }
  });

  socket.on(C2S.messageRead, async (payload, ack) => {
    try {
      const input = readReceiptSchema.parse(payload ?? {});
      if (!(await ensureConversationRoom(socket, input.conversationId))) {
        throw new ApiError(404, "conversation_not_found", "Conversation not found");
      }
      const receipt = await messagesService.markRead(socket.data.userId, input.conversationId, {
        messageIds: input.messageIds,
        upToMessageId: input.upToMessageId,
      });
      ack?.({ ok: true, data: receipt });
    } catch (error) {
      ack?.(toAckError(error));
    }
  });

  socket.on(C2S.typingStart, async (payload, ack) => {
    try {
      const { conversationId } = typingEventSchema.parse(payload ?? {});
      if (!(await ensureConversationRoom(socket, conversationId))) {
        throw new ApiError(404, "conversation_not_found", "Conversation not found");
      }
      await typingService.setTyping(io, socket.id, conversationId, socket.data.userId, true);
      ack?.({ ok: true, data: { conversationId } });
    } catch (error) {
      ack?.(toAckError(error));
    }
  });

  socket.on(C2S.typingStop, async (payload, ack) => {
    try {
      const { conversationId } = typingEventSchema.parse(payload ?? {});
      if (!(await ensureConversationRoom(socket, conversationId))) {
        throw new ApiError(404, "conversation_not_found", "Conversation not found");
      }
      await typingService.setTyping(io, socket.id, conversationId, socket.data.userId, false);
      ack?.({ ok: true, data: { conversationId } });
    } catch (error) {
      ack?.(toAckError(error));
    }
  });

  socket.on(C2S.presenceHeartbeat, () => {
    void presence.touch(socket.data.userId);
  });
}

/** Translates domain events from the realtime bus into Socket.IO broadcasts. */
function subscribeBus(io: ChatServer): void {
  onBus("session:revoked", ({ sessionId }) => {
    void io.in(ROOM.session(sessionId)).disconnectSockets(true);
  });

  onBus("message:new", ({ conversationId, message }) => {
    io.to(ROOM.conversation(conversationId)).emit(S2C.messageNew, { message });
  });

  onBus("message:update", ({ conversationId, message }) => {
    io.to(ROOM.conversation(conversationId)).emit(S2C.messageUpdate, { message });
  });

  onBus("receipts:update", (receipt) => {
    io.to(ROOM.conversation(receipt.conversationId)).emit(S2C.receiptsUpdate, receipt);
  });

  onBus("conversation:read", (payload) => {
    io.to(ROOM.conversation(payload.conversationId)).emit(S2C.conversationRead, payload);
  });

  onBus("notification:new", ({ userId, notification }) => {
    io.to(ROOM.user(userId)).emit(S2C.notificationNew, { notification });
  });

  onBus("conversation:created", async ({ conversation, userIds }) => {
    for (const userId of userIds) {
      io.to(ROOM.user(userId)).emit(S2C.conversationNew, { conversation });
      await io.in(ROOM.user(userId)).socketsJoin(ROOM.conversation(conversation.id));
    }
    await presence.invalidateContactsCache(userIds);
  });

  onBus("conversation:updated", ({ conversation, userIds }) => {
    io.to(ROOM.conversation(conversation.id)).emit(S2C.conversationUpdated, { conversation });
    io.to(userIds.map((id) => ROOM.user(id))).emit(S2C.conversationUpdated, { conversation });
  });

  onBus("conversation:member:left", async ({ conversationId, userId, reason }) => {
    io.to(ROOM.user(userId)).emit(S2C.conversationRemoved, { conversationId, reason });
    await io.in(ROOM.user(userId)).socketsLeave(ROOM.conversation(conversationId));
    await presence.invalidateContactsCache([userId]);
  });

  onBus("conversation:deleted", async ({ conversationId, userIds }) => {
    for (const userId of userIds) {
      io.to(ROOM.user(userId)).emit(S2C.conversationRemoved, {
        conversationId,
        reason: "deleted",
      });
      await io.in(ROOM.user(userId)).socketsLeave(ROOM.conversation(conversationId));
    }
    await presence.invalidateContactsCache(userIds);
  });
}
