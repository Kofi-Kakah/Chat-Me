import { Prisma } from "../../../generated/prisma/client";
import { toNotificationDTO, type NotificationDTO } from "../../lib/mappers";
import { prisma } from "../../lib/prisma";
import { emitBus } from "../../lib/realtime-bus";
import { ApiError } from "../../middleware/error";
import type { ListNotificationsInput } from "./notifications.schemas";

export interface NotificationPage {
  notifications: NotificationDTO[];
  nextCursor: string | null;
}

export async function listNotifications(
  meId: string,
  options: ListNotificationsInput,
): Promise<NotificationPage> {
  let beforeDate: Date | null = null;
  if (options.before) {
    beforeDate = new Date(options.before);
    if (Number.isNaN(beforeDate.getTime())) {
      throw new ApiError(422, "invalid_cursor", "Invalid pagination cursor");
    }
  }

  const rows = await prisma.notification.findMany({
    where: {
      userId: meId,
      ...(options.unreadOnly ? { readAt: null } : {}),
      ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    notifications: page.map((row) => toNotificationDTO(row)),
    nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
  };
}

export async function unreadCount(meId: string): Promise<number> {
  return prisma.notification.count({ where: { userId: meId, readAt: null } });
}

export async function markNotificationRead(
  meId: string,
  notificationId: string,
): Promise<NotificationDTO> {
  const existing = await prisma.notification.findFirst({
    where: { id: notificationId, userId: meId },
    select: { id: true },
  });
  if (!existing) throw new ApiError(404, "notification_not_found", "Notification not found");

  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: { readAt: new Date() },
  });
  return toNotificationDTO(updated);
}

export async function markAllNotificationsRead(meId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { userId: meId, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}

export interface GroupInviteNotificationInput {
  inviter: { id: string; username: string; displayName: string | null };
  conversationId: string;
  conversationTitle: string;
  memberIds: string[];
}

/** Creates GROUP_INVITE notifications (one per member) and pushes them live. */
export async function createGroupInviteNotifications(
  input: GroupInviteNotificationInput,
): Promise<void> {
  if (input.memberIds.length === 0) return;

  const payload = {
    conversationId: input.conversationId,
    conversationTitle: input.conversationTitle,
    inviter: input.inviter,
  };

  // A single multi-row insert: the previous per-member transaction cost one
  // round trip per invitee and, being the array form, could not be given a
  // connection-wait ceiling.
  const rows = await prisma.notification.createManyAndReturn({
    data: input.memberIds.map((userId) => ({
      userId,
      type: "GROUP_INVITE" as const,
      payload: payload as Prisma.InputJsonValue,
    })),
  });

  for (const row of rows) {
    emitBus("notification:new", { userId: row.userId, notification: toNotificationDTO(row) });
  }
}
