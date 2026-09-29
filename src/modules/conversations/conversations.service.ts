import { Prisma } from "../../../generated/prisma/client";
import {
  PUBLIC_USER_SELECT,
  toPublicUser,
  type ConversationDTO,
  type ConversationMemberDTO,
  type ConversationType,
  type MemberRole,
  type MessageDTO,
  type PublicUser,
} from "../../lib/mappers";
import { prisma } from "../../lib/prisma";
import { emitBus } from "../../lib/realtime-bus";
import { TRANSACTION_OPTIONS } from "../../lib/transaction";
import { ApiError } from "../../middleware/error";
import { createGroupInviteNotifications } from "../notifications/notifications.service";
import type { CreateGroupInput, UpdateConversationInput } from "./conversations.schemas";

const conversationInclude = {
  members: {
    where: { leftAt: null },
    include: { user: { select: PUBLIC_USER_SELECT } },
  },
} satisfies Prisma.ConversationInclude;

type ConversationWithMembers = Prisma.ConversationGetPayload<{
  include: typeof conversationInclude;
}>;

export interface ActiveMembership {
  role: MemberRole;
  conversation: { id: string; type: ConversationType; title: string | null };
}

/** Verifies the user is an active member; throws 404 otherwise. */
export async function assertActiveMembership(
  userId: string,
  conversationId: string,
): Promise<ActiveMembership> {
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: {
      leftAt: true,
      role: true,
      conversation: { select: { id: true, type: true, title: true } },
    },
  });
  if (!membership || membership.leftAt) {
    throw new ApiError(404, "conversation_not_found", "Conversation not found");
  }
  return { role: membership.role, conversation: membership.conversation };
}

async function requireMembership(
  userId: string,
  conversationId: string,
): Promise<{ role: MemberRole; conversationType: ConversationType }> {
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: {
      leftAt: true,
      role: true,
      conversation: { select: { type: true } },
    },
  });
  if (!membership || membership.leftAt) {
    throw new ApiError(404, "conversation_not_found", "Conversation not found");
  }
  return { role: membership.role, conversationType: membership.conversation.type };
}

function requireRole(role: MemberRole, allowed: MemberRole[]): void {
  if (!allowed.includes(role)) {
    throw new ApiError(403, "forbidden", "You do not have permission to perform this action");
  }
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

export async function listConversations(meId: string): Promise<ConversationDTO[]> {
  const memberships = await prisma.conversationMember.findMany({
    where: { userId: meId, leftAt: null },
    include: { conversation: { include: conversationInclude } },
    orderBy: { conversation: { updatedAt: "desc" } },
  });

  if (memberships.length === 0) return [];

  const conversationIds = memberships.map((m) => m.conversation.id);
  const [lastMessages, unread] = await Promise.all([
    fetchLastMessages(conversationIds),
    fetchUnreadCounts(meId, conversationIds),
  ]);

  const dtos = memberships.map((m) =>
    buildConversationDTO(
      m.conversation,
      meId,
      m.role,
      unread.get(m.conversation.id) ?? 0,
      lastMessages.get(m.conversation.id) ?? null,
    ),
  );

  dtos.sort((a, b) => {
    const aTime = a.lastMessage?.createdAt ?? a.updatedAt;
    const bTime = b.lastMessage?.createdAt ?? b.updatedAt;
    return bTime.localeCompare(aTime);
  });
  return dtos;
}

async function fetchLastMessages(conversationIds: string[]): Promise<Map<string, MessageDTO>> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      conversationId: string;
      senderId: string;
      clientId: string | null;
      body: string | null;
      attachments: unknown;
      replyToId: string | null;
      createdAt: Date;
      editedAt: Date | null;
      senderId2: string;
      senderUsername: string;
      senderDisplayName: string | null;
      senderAvatarUrl: string | null;
    }>
  >(Prisma.sql`
    SELECT DISTINCT ON (m."conversationId")
      m."id",
      m."conversationId",
      m."senderId",
      m."clientId",
      m."body",
      m."attachments",
      m."replyToId",
      m."createdAt",
      m."editedAt",
      u."id" AS "senderId2",
      u."username" AS "senderUsername",
      u."displayName" AS "senderDisplayName",
      u."avatarUrl" AS "senderAvatarUrl"
    FROM "Message" m
    JOIN "User" u ON u."id" = m."senderId"
    WHERE m."conversationId" IN (${Prisma.join(conversationIds)})
      AND m."deletedAt" IS NULL
    ORDER BY m."conversationId", m."createdAt" DESC, m."id" DESC
  `);

  const map = new Map<string, MessageDTO>();
  for (const row of rows) {
    map.set(row.conversationId, {
      id: row.id,
      conversationId: row.conversationId,
      senderId: row.senderId,
      clientId: row.clientId,
      body: row.body,
      attachments: row.attachments ?? null,
      replyToId: row.replyToId,
      replyTo: null,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt ? row.editedAt.toISOString() : null,
      deletedAt: null,
      sender: {
        id: row.senderId2,
        username: row.senderUsername,
        displayName: row.senderDisplayName,
        avatarUrl: row.senderAvatarUrl,
      },
    });
  }
  return map;
}

async function fetchUnreadCounts(
  meId: string,
  conversationIds: string[],
): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ conversationId: string; unread: number }>>(Prisma.sql`
    SELECT cm."conversationId" AS "conversationId", COUNT(*)::int AS "unread"
    FROM "ConversationMember" cm
    JOIN "Message" m ON m."conversationId" = cm."conversationId"
    WHERE cm."userId" = ${meId}
      AND cm."leftAt" IS NULL
      AND cm."conversationId" IN (${Prisma.join(conversationIds)})
      AND m."deletedAt" IS NULL
      AND m."senderId" <> ${meId}
      AND (cm."lastReadAt" IS NULL OR m."createdAt" > cm."lastReadAt")
    GROUP BY cm."conversationId"
  `);
  return new Map(rows.map((r) => [r.conversationId, Number(r.unread)]));
}

/* ------------------------------------------------------------------ */
/* Reads & creation                                                    */
/* ------------------------------------------------------------------ */

export async function getConversation(
  meId: string,
  conversationId: string,
): Promise<ConversationDTO> {
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: meId } },
    include: { conversation: { include: conversationInclude } },
  });
  if (!membership || membership.leftAt) {
    throw new ApiError(404, "conversation_not_found", "Conversation not found");
  }

  const [lastMessages, unread] = await Promise.all([
    fetchLastMessages([conversationId]),
    fetchUnreadCounts(meId, [conversationId]),
  ]);

  return buildConversationDTO(
    membership.conversation,
    meId,
    membership.role,
    unread.get(conversationId) ?? 0,
    lastMessages.get(conversationId) ?? null,
  );
}

function buildConversationDTO(
  conversation: ConversationWithMembers,
  meId: string,
  myRole: MemberRole,
  unreadCount: number,
  lastMessage: MessageDTO | null,
): ConversationDTO {
  const members: ConversationMemberDTO[] = conversation.members.map((m) => ({
    userId: m.userId,
    role: m.role,
    joinedAt: m.joinedAt.toISOString(),
    user: toPublicUser(m.user),
  }));
  const otherMember =
    conversation.type === "DIRECT"
      ? (conversation.members.find((m) => m.userId !== meId) ?? null)
      : null;
  const directUser: PublicUser | null = otherMember ? toPublicUser(otherMember.user) : null;
  const title =
    conversation.type === "GROUP"
      ? (conversation.title ?? "Group")
      : directUser
        ? (directUser.displayName ?? directUser.username)
        : "Direct message";

  return {
    id: conversation.id,
    type: conversation.type,
    title,
    imageUrl: conversation.imageUrl,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    myRole,
    unreadCount,
    lastMessage,
    mutedUntil:
      conversation.members.find((member) => member.userId === meId)?.mutedUntil?.toISOString() ?? null,
    members,
    directUser,
  };
}

export async function createDirectConversation(
  meId: string,
  otherUserId: string,
): Promise<ConversationDTO> {
  if (otherUserId === meId) {
    throw new ApiError(400, "invalid_target", "Cannot create a direct conversation with yourself");
  }

  const other = await prisma.user.findUnique({ where: { id: otherUserId }, select: { id: true } });
  if (!other) throw new ApiError(404, "user_not_found", "User not found");

  // Canonical sorted pair key makes direct conversations idempotent.
  const directKey = [meId, otherUserId].sort().join(":");

  const existing = await prisma.conversation.findUnique({
    where: { directKey },
    include: conversationInclude,
  });

  if (existing) {
    const membership = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: existing.id, userId: meId } },
    });
    if (membership?.leftAt) {
      await prisma.conversationMember.update({
        where: { conversationId_userId: { conversationId: existing.id, userId: meId } },
        data: { leftAt: null },
      });
    }
    return getConversation(meId, existing.id);
  }

  const created = await prisma.conversation.create({
    data: {
      type: "DIRECT",
      directKey,
      updatedAt: new Date(),
      members: { create: [{ userId: meId }, { userId: otherUserId }] },
    },
    select: { id: true },
  });

  const dto = await getConversation(meId, created.id);
  emitBus("conversation:created", { conversation: dto, userIds: [meId, otherUserId] });
  return dto;
}

export async function createGroupConversation(
  meId: string,
  input: CreateGroupInput,
): Promise<ConversationDTO> {
  const memberIds = [...new Set(input.memberIds)].filter((id) => id !== meId);
  if (memberIds.length === 0) {
    throw new ApiError(422, "invalid_members", "At least one other member is required");
  }

  const found = await prisma.user.findMany({
    where: { id: { in: memberIds } },
    select: { id: true },
  });
  if (found.length !== memberIds.length) {
    const missing = memberIds.filter((id) => !found.some((u) => u.id === id));
    throw new ApiError(404, "user_not_found", "One or more members do not exist", { missing });
  }

  const inviter = await prisma.user.findUniqueOrThrow({
    where: { id: meId },
    select: { id: true, username: true, displayName: true },
  });

  const conversation = await prisma.conversation.create({
    data: {
      type: "GROUP",
      title: input.title,
      imageUrl: input.imageUrl ?? null,
      updatedAt: new Date(),
      members: {
        create: [
          { userId: meId, role: "OWNER" },
          ...memberIds.map((userId) => ({ userId, role: "MEMBER" as const })),
        ],
      },
    },
    select: { id: true, title: true },
  });

  await createGroupInviteNotifications({
    inviter,
    conversationId: conversation.id,
    conversationTitle: conversation.title ?? "Group",
    memberIds,
  });

  const dto = await getConversation(meId, conversation.id);
  emitBus("conversation:created", { conversation: dto, userIds: [meId, ...memberIds] });
  return dto;
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export async function updateConversation(
  meId: string,
  conversationId: string,
  data: UpdateConversationInput,
): Promise<ConversationDTO> {
  const membership = await requireMembership(meId, conversationId);
  if (membership.conversationType !== "GROUP") {
    throw new ApiError(400, "invalid_operation", "Only group conversations can be updated");
  }
  requireRole(membership.role, ["OWNER", "ADMIN"]);

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { title: data.title, imageUrl: data.imageUrl },
  });

  const dto = await getConversation(meId, conversationId);
  emitBus("conversation:updated", {
    conversation: dto,
    userIds: dto.members.map((m) => m.userId),
  });
  return dto;
}

export async function addMembers(
  meId: string,
  conversationId: string,
  userIds: string[],
): Promise<ConversationDTO> {
  const membership = await requireMembership(meId, conversationId);
  if (membership.conversationType !== "GROUP") {
    throw new ApiError(400, "invalid_operation", "Members can only be added to group conversations");
  }
  requireRole(membership.role, ["OWNER", "ADMIN"]);

  const unique = [...new Set(userIds)].filter((id) => id !== meId);
  if (unique.length === 0) {
    throw new ApiError(422, "invalid_members", "Provide at least one user to add");
  }

  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true } });
  if (users.length !== unique.length) {
    const missing = unique.filter((id) => !users.some((u) => u.id === id));
    throw new ApiError(404, "user_not_found", "One or more users do not exist", { missing });
  }

  const existing = await prisma.conversationMember.findMany({
    where: { conversationId, userId: { in: unique } },
    select: { userId: true, leftAt: true },
  });
  const existingMap = new Map(existing.map((e) => [e.userId, e.leftAt]));

  const toCreate = unique.filter((id) => !existingMap.has(id));
  const toReactivate = unique.filter((id) => existingMap.has(id) && existingMap.get(id) !== null);

  await prisma.$transaction(async (tx) => {
    await tx.conversationMember.createMany({
      data: toCreate.map((userId) => ({ conversationId, userId, role: "MEMBER" as const })),
      skipDuplicates: true,
    });
    await tx.conversationMember.updateMany({
      where: { conversationId, userId: { in: toReactivate } },
      data: { leftAt: null, joinedAt: new Date() },
    });
  }, TRANSACTION_OPTIONS);

  const affected = [...toCreate, ...toReactivate];
  if (affected.length > 0) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { title: true },
    });
    await createGroupInviteNotifications({
      inviter: await prisma.user.findUniqueOrThrow({
        where: { id: meId },
        select: { id: true, username: true, displayName: true },
      }),
      conversationId,
      conversationTitle: conversation?.title ?? "Group",
      memberIds: affected,
    });
  }

  const dto = await getConversation(meId, conversationId);
  if (affected.length > 0) {
    emitBus("conversation:created", { conversation: dto, userIds: affected });
  }
  emitBus("conversation:updated", {
    conversation: dto,
    userIds: dto.members.map((m) => m.userId),
  });
  return dto;
}

export async function removeMember(
  meId: string,
  conversationId: string,
  targetUserId: string,
): Promise<ConversationDTO> {
  const membership = await requireMembership(meId, conversationId);
  if (membership.conversationType !== "GROUP") {
    throw new ApiError(400, "invalid_operation", "Members can only be removed from group conversations");
  }
  requireRole(membership.role, ["OWNER", "ADMIN"]);

  const target = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
  });
  if (!target || target.leftAt) {
    throw new ApiError(404, "member_not_found", "User is not a member of this conversation");
  }
  if (target.role === "OWNER") {
    throw new ApiError(403, "forbidden", "The group owner cannot be removed");
  }

  // Soft leave: the row is retained and every read filters on `leftAt: null`.
  // Keeping it preserves receipt history and the `joinedAt` ordering that
  // ownership succession depends on if the member is re-added later.
  await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
    data: { leftAt: new Date() },
  });

  emitBus("conversation:member:left", {
    conversationId,
    userId: targetUserId,
    reason: "removed",
  });

  const dto = await getConversation(meId, conversationId);
  emitBus("conversation:updated", {
    conversation: dto,
    userIds: dto.members.map((m) => m.userId),
  });
  return dto;
}

export async function leaveConversation(meId: string, conversationId: string): Promise<void> {
  const membership = await requireMembership(meId, conversationId);
  if (membership.conversationType === "DIRECT") {
    throw new ApiError(400, "invalid_operation", "Direct conversations cannot be left");
  }

  const remaining = await prisma.conversationMember.findMany({
    where: { conversationId, leftAt: null, userId: { not: meId } },
    orderBy: { joinedAt: "asc" },
    select: { userId: true },
  });

  if (remaining.length === 0) {
    // Last member leaving deletes the group entirely.
    await prisma.conversation.delete({ where: { id: conversationId } });
    emitBus("conversation:deleted", { conversationId, userIds: [meId] });
    return;
  }

  await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId, userId: meId } },
    data: { leftAt: new Date() },
  });

  if (membership.role === "OWNER") {
    // Transfer ownership to the longest-standing remaining member.
    await prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId: remaining[0].userId } },
      data: { role: "OWNER" },
    });
  }

  emitBus("conversation:member:left", { conversationId, userId: meId, reason: "left" });

  const dto = await getConversation(remaining[0].userId, conversationId);
  emitBus("conversation:updated", {
    conversation: dto,
    userIds: dto.members.map((m) => m.userId),
  });
}

export async function deleteConversation(meId: string, conversationId: string): Promise<void> {
  const membership = await requireMembership(meId, conversationId);
  if (membership.conversationType !== "GROUP") {
    throw new ApiError(400, "invalid_operation", "Only group conversations can be deleted");
  }
  requireRole(membership.role, ["OWNER"]);

  const members = await prisma.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true },
  });

  await prisma.conversation.delete({ where: { id: conversationId } });
  emitBus("conversation:deleted", {
    conversationId,
    userIds: members.map((m) => m.userId),
  });
}
