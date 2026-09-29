import { Prisma } from "../../../generated/prisma/client";
import {
  toMessageDTO,
  toNotificationDTO,
  type MessageDTO,
  type NotificationDTO,
  type ReceiptUpdate,
} from "../../lib/mappers";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { extractMentionedUsernames } from "../../lib/mentions";
import { emitBus } from "../../lib/realtime-bus";
import { TRANSACTION_OPTIONS } from "../../lib/transaction";
import { ApiError } from "../../middleware/error";
import { assertActiveMembership } from "../conversations/conversations.service";
import type { ListMessagesInput, SendMessageInput } from "./messages.schemas";

const MESSAGE_INCLUDE = {
  sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
  replyTo: {
    select: {
      id: true,
      body: true,
      deletedAt: true,
      sender: { select: { username: true } },
    },
  },
} satisfies Prisma.MessageInclude;

type Actor = { id: string; username: string; displayName: string | null; avatarUrl: string | null };

/* ------------------------------------------------------------------ */
/* History (keyset pagination)                                         */
/* ------------------------------------------------------------------ */

export interface MessagePage {
  messages: MessageDTO[];
  nextCursor: string | null;
}

export async function listMessages(
  meId: string,
  conversationId: string,
  options: ListMessagesInput,
): Promise<MessagePage> {
  await assertActiveMembership(meId, conversationId);

  const cursor = decodeCursor(options.before);
  const descending = options.order === "desc";
  const comparator = descending ? "lt" : "gt";

  const where: Prisma.MessageWhereInput = {
    conversationId,
    ...(cursor
      ? {
          OR: [
            { createdAt: { [comparator]: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { [comparator]: cursor.id } },
          ],
        }
      : {}),
  };

  const rows = await prisma.message.findMany({
    where,
    include: MESSAGE_INCLUDE,
    orderBy: [
      { createdAt: descending ? "desc" : "asc" },
      { id: descending ? "desc" : "asc" },
    ],
    take: options.limit + 1,
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    messages: page.map((row) => toMessageDTO(row)),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}

function encodeCursor(message: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: message.createdAt.toISOString(), id: message.id }),
  ).toString("base64url");
}

function decodeCursor(cursor?: string): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  let parsed: { createdAt?: unknown; id?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ApiError(422, "invalid_cursor", "Invalid pagination cursor");
  }
  if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
    throw new ApiError(422, "invalid_cursor", "Invalid pagination cursor");
  }
  const createdAt = new Date(parsed.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new ApiError(422, "invalid_cursor", "Invalid pagination cursor");
  }
  return { createdAt, id: parsed.id };
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

export async function sendMessage(
  actor: Actor,
  conversationId: string,
  input: Omit<SendMessageInput, "conversationId">,
): Promise<MessageDTO> {
  logger.debug("send: start", { conversationId, actorId: actor.id });
  const membership = await assertActiveMembership(actor.id, conversationId);
  logger.debug("send: membership ok", { conversationId });

  const clientId = input.clientId || null;
  if (clientId) {
    const previous = await prisma.message.findUnique({
      where: {
        conversationId_senderId_clientId: {
          conversationId,
          senderId: actor.id,
          clientId,
        },
      },
      include: MESSAGE_INCLUDE,
    });
    if (previous) return toMessageDTO(previous);
  }

  const hasBody = typeof input.body === "string" && input.body.length > 0;
  const hasAttachments = Array.isArray(input.attachments) && input.attachments.length > 0;
  if (!hasBody && !hasAttachments) {
    throw new ApiError(422, "invalid_message", "Message must include a body or attachments");
  }

  if (input.replyToId) {
    const reply = await prisma.message.findFirst({
      where: { id: input.replyToId, conversationId },
      select: { id: true },
    });
    if (!reply) {
      throw new ApiError(422, "invalid_reply", "replyToId must reference a message in the same conversation");
    }
  }

  const mentionedUsernames = extractMentionedUsernames(input.body);

  // The actor row, the recipient list and any mentioned users are independent
  // reads, so they are issued together rather than one round trip at a time.
  const [actorUser, others, mentionedUsers] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: actor.id },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
    }),
    prisma.conversationMember.findMany({
      where: { conversationId, leftAt: null, userId: { not: actor.id } },
      select: { userId: true, mutedUntil: true },
    }),
    mentionedUsernames.size > 0
      ? prisma.user.findMany({
          where: { username: { in: [...mentionedUsernames] } },
          select: { id: true },
        })
      : Promise.resolve([] as Array<{ id: string }>),
  ]);

  // A mention only carries meaning in a group: a direct message is already
  // addressed at its single recipient.
  const mentionedIds =
    membership.conversation.type === "GROUP"
      ? new Set(mentionedUsers.map((user) => user.id))
      : new Set<string>();

  logger.debug("send: participants loaded", {
    conversationId,
    recipients: others.length,
    mentions: mentionedIds.size,
  });

  const now = new Date();
  const notificationPayload = {
    conversationId,
    conversationType: membership.conversation.type,
    conversationTitle:
      membership.conversation.type === "GROUP"
        ? (membership.conversation.title ?? "Group")
        : (actorUser.displayName ?? actorUser.username),
    sender: actorUser,
    snippet: hasBody ? (input.body as string).slice(0, 140) : "[Attachment]",
  };

  let message: Prisma.MessageGetPayload<{ include: typeof MESSAGE_INCLUDE }>;
  let notifications: Array<{ userId: string; notification: NotificationDTO }>;
  try {
    ({ message, notifications } = await prisma.$transaction(async (tx) => {
    logger.debug("send: tx begin", { conversationId });
    const message = await tx.message.create({
      data: {
        conversationId,
        senderId: actor.id,
        clientId,
        body: hasBody ? (input.body as string) : null,
        attachments: hasAttachments
          ? (input.attachments as unknown as Prisma.InputJsonValue)
          : undefined,
        replyToId: input.replyToId ?? null,
      },
      include: MESSAGE_INCLUDE,
    });

    const createdNotifications: Array<{ userId: string; notification: NotificationDTO }> = [];
    if (others.length > 0) {
      // Sent receipts: one row per recipient (delivered/read set later).
      await tx.messageRead.createMany({
        data: others.map((member) => ({ messageId: message.id, userId: member.userId })),
      });
      const recipients = others.filter(
        (member) => !member.mutedUntil || member.mutedUntil.getTime() <= now.getTime(),
      );
      if (recipients.length > 0) {
        // One multi-row insert instead of a round trip per recipient: the
        // per-row loop used to dominate a large group's send latency.
        const rows = await tx.notification.createManyAndReturn({
          data: recipients.map((member) => {
            // A mention supersedes the plain new-message notification so a
            // client can badge it differently without de-duplicating.
            const isMention = mentionedIds.has(member.userId);
            return {
              userId: member.userId,
              type: isMention ? ("MENTION" as const) : ("MESSAGE" as const),
              messageId: message.id,
              payload: { ...notificationPayload, mentioned: isMention } as Prisma.InputJsonValue,
            };
          }),
        });
        for (const row of rows) {
          createdNotifications.push({ userId: row.userId, notification: toNotificationDTO(row) });
        }
      }
    }

    await tx.conversation.update({ where: { id: conversationId }, data: { updatedAt: now } });
    logger.debug("send: tx commit", { conversationId });
    return { message, notifications: createdNotifications };
    }, TRANSACTION_OPTIONS));
  } catch (error) {
    // Concurrent retries can both miss the initial lookup. The unique index
    // makes the insert atomic; return the winner's message to the other caller.
    if (clientId && (error as { code?: string })?.code === "P2002") {
      const previous = await prisma.message.findUnique({
        where: {
          conversationId_senderId_clientId: {
            conversationId,
            senderId: actor.id,
            clientId,
          },
        },
        include: MESSAGE_INCLUDE,
      });
      if (previous) return toMessageDTO(previous);
    }
    throw error;
  }

  const dto = toMessageDTO(message);
  logger.debug("send: done", { conversationId, messageId: dto.id });
  emitBus("message:new", { conversationId, message: dto });
  for (const entry of notifications) {
    emitBus("notification:new", entry);
  }
  return dto;
}

/* ------------------------------------------------------------------ */
/* Single message operations                                           */
/* ------------------------------------------------------------------ */

export async function getMessage(meId: string, messageId: string): Promise<MessageDTO> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: MESSAGE_INCLUDE,
  });
  if (!message) throw new ApiError(404, "message_not_found", "Message not found");
  await assertActiveMembership(meId, message.conversationId);
  return toMessageDTO(message);
}

export async function editMessage(
  meId: string,
  messageId: string,
  body: string,
): Promise<MessageDTO> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: MESSAGE_INCLUDE,
  });
  if (!message) throw new ApiError(404, "message_not_found", "Message not found");
  if (message.senderId !== meId) {
    throw new ApiError(403, "forbidden", "Only the sender can edit a message");
  }
  if (message.deletedAt) {
    throw new ApiError(409, "message_deleted", "Deleted messages cannot be edited");
  }
  await assertActiveMembership(meId, message.conversationId);

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { body, editedAt: new Date() },
    include: MESSAGE_INCLUDE,
  });

  const dto = toMessageDTO(updated);
  emitBus("message:update", { conversationId: dto.conversationId, message: dto });
  return dto;
}

export async function deleteMessage(meId: string, messageId: string): Promise<MessageDTO> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { ...MESSAGE_INCLUDE, conversation: { select: { type: true } } },
  });
  if (!message) throw new ApiError(404, "message_not_found", "Message not found");

  if (message.senderId !== meId) {
    // Group moderators may moderate any message in the conversation.
    const membership = await prisma.conversationMember.findUnique({
      where: {
        conversationId_userId: { conversationId: message.conversationId, userId: meId },
      },
    });
    const isModerator =
      membership !== null && !membership.leftAt && (membership.role === "OWNER" || membership.role === "ADMIN");
    if (!(message.conversation.type === "GROUP" && isModerator)) {
      throw new ApiError(403, "forbidden", "You cannot delete this message");
    }
  }

  // Soft delete keeps the thread intact as a tombstone while redacting content.
  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), body: null, attachments: Prisma.DbNull },
    include: MESSAGE_INCLUDE,
  });

  const dto = toMessageDTO(updated);
  emitBus("message:update", { conversationId: dto.conversationId, message: dto });
  return dto;
}

/* ------------------------------------------------------------------ */
/* Delivery & read receipts                                            */
/* ------------------------------------------------------------------ */

export async function markDelivered(
  meId: string,
  conversationId: string,
  messageIds?: string[],
): Promise<ReceiptUpdate> {
  await assertActiveMembership(meId, conversationId);

  let ids: string[];
  if (messageIds && messageIds.length > 0) {
    const rows = await prisma.message.findMany({
      where: { id: { in: messageIds }, conversationId },
      select: { id: true },
    });
    ids = rows.map((r) => r.id);
  } else {
    const rows = await prisma.message.findMany({
      where: {
        conversationId,
        senderId: { not: meId },
        deletedAt: null,
        reads: { some: { userId: meId, deliveredAt: null } },
      },
      select: { id: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    ids = rows.map((r) => r.id);
  }

  if (ids.length === 0) {
    return { conversationId, userId: meId, messageIds: [] };
  }

  const deliveredAt = new Date();
  await prisma.messageRead.updateMany({
    where: { messageId: { in: ids }, userId: meId, deliveredAt: null },
    data: { deliveredAt },
  });

  const receipt: ReceiptUpdate = {
    conversationId,
    userId: meId,
    messageIds: ids,
    deliveredAt: deliveredAt.toISOString(),
  };
  emitBus("receipts:update", receipt);
  return receipt;
}

export async function markRead(
  meId: string,
  conversationId: string,
  options: { messageIds?: string[]; upToMessageId?: string } = {},
): Promise<ReceiptUpdate> {
  await assertActiveMembership(meId, conversationId);

  let cutoff = new Date();

  if (options.upToMessageId) {
    const anchor = await prisma.message.findFirst({
      where: { id: options.upToMessageId, conversationId },
      select: { id: true, createdAt: true },
    });
    if (!anchor) {
      throw new ApiError(422, "invalid_message", "upToMessageId must reference a message in this conversation");
    }
    cutoff = anchor.createdAt;
  }

  let ids: string[] = [];
  if (options.messageIds && options.messageIds.length > 0) {
    const rows = await prisma.message.findMany({
      where: { id: { in: options.messageIds }, conversationId, senderId: { not: meId } },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    ids = rows.map((r) => r.id);
    if (rows.length > 0) cutoff = rows[0].createdAt;
  } else {
    const rows = await prisma.message.findMany({
      where: {
        conversationId,
        senderId: { not: meId },
        deletedAt: null,
        ...(options.upToMessageId ? { createdAt: { lte: cutoff } } : {}),
      },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
    });
    ids = rows.map((r) => r.id);
  }

  const now = new Date();
  if (ids.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.messageRead.createMany({
        data: ids.map((messageId) => ({ messageId, userId: meId, deliveredAt: now, readAt: now })),
        skipDuplicates: true,
      });
      await tx.messageRead.updateMany({
        where: { messageId: { in: ids }, userId: meId, readAt: null },
        data: { deliveredAt: now, readAt: now },
      });
      await tx.conversationMember.update({
        where: { conversationId_userId: { conversationId, userId: meId } },
        data: { lastReadAt: cutoff },
      });
    }, TRANSACTION_OPTIONS);
  } else {
    await prisma.conversationMember
      .update({
        where: { conversationId_userId: { conversationId, userId: meId } },
        data: { lastReadAt: cutoff },
      })
      .catch(() => undefined);
  }

  const receipt: ReceiptUpdate = {
    conversationId,
    userId: meId,
    messageIds: ids,
    deliveredAt: now.toISOString(),
    readAt: now.toISOString(),
  };
  emitBus("receipts:update", receipt);
  emitBus("conversation:read", {
    conversationId,
    userId: meId,
    lastReadAt: cutoff.toISOString(),
  });
  return receipt;
}

/* ------------------------------------------------------------------ */
/* Delivery on reconnect                                               */
/* ------------------------------------------------------------------ */

/** Upper bound on the backlog acknowledged in one connect, to cap the work. */
const MAX_PENDING_DELIVERIES = 500;

/**
 * Acknowledges everything still awaiting delivery to this user and tells each
 * sender. A client that was offline otherwise stays "sent" until the user opens
 * every individual conversation, so the receipts never reach the sender in one
 * pass. Called when a socket connects.
 */
export async function markPendingDelivered(userId: string): Promise<void> {
  const pending = await prisma.messageRead.findMany({
    where: { userId, deliveredAt: null },
    select: { messageId: true, message: { select: { conversationId: true } } },
    orderBy: { messageId: "asc" },
    take: MAX_PENDING_DELIVERIES,
  });
  if (pending.length === 0) return;

  const deliveredAt = new Date();
  await prisma.messageRead.updateMany({
    where: { userId, deliveredAt: null, messageId: { in: pending.map((row) => row.messageId) } },
    data: { deliveredAt },
  });

  const byConversation = new Map<string, string[]>();
  for (const row of pending) {
    const conversationId = row.message.conversationId;
    const ids = byConversation.get(conversationId);
    if (ids) ids.push(row.messageId);
    else byConversation.set(conversationId, [row.messageId]);
  }

  for (const [conversationId, messageIds] of byConversation) {
    emitBus("receipts:update", {
      conversationId,
      userId,
      messageIds,
      deliveredAt: deliveredAt.toISOString(),
    });
  }
}
