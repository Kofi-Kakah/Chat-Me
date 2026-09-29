import type { Prisma } from "../../generated/prisma/client";

export const PUBLIC_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  isOnline: true,
  lastSeenAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  isOnline: boolean;
  lastSeenAt: string | null;
  createdAt: string;
};

export type SenderSummary = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type MessageDTO = {
  id: string;
  conversationId: string;
  senderId: string;
  clientId: string | null;
  body: string | null;
  attachments: unknown | null;
  replyToId: string | null;
  replyTo: {
    id: string;
    body: string | null;
    deletedAt: string | null;
    senderUsername: string;
  } | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  sender: SenderSummary;
};

export type MemberRole = "OWNER" | "ADMIN" | "MEMBER";
export type ConversationType = "DIRECT" | "GROUP";

export type ConversationMemberDTO = {
  userId: string;
  role: MemberRole;
  joinedAt: string;
  user: PublicUser;
};

export type ConversationDTO = {
  id: string;
  type: ConversationType;
  title: string | null;
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
  myRole: MemberRole;
  unreadCount: number;
  lastMessage: MessageDTO | null;
  members: ConversationMemberDTO[];
  directUser: PublicUser | null;
  /**
   * End of the caller's own mute window, or null when notifications are on.
   * Muting is per member, so this is always the requesting user's setting.
   */
  mutedUntil: string | null;
};

export type NotificationType = "MESSAGE" | "MENTION" | "GROUP_INVITE";

export type NotificationDTO = {
  id: string;
  type: NotificationType;
  messageId: string | null;
  payload: unknown;
  createdAt: string;
  readAt: string | null;
};

export type ReceiptUpdate = {
  conversationId: string;
  userId: string;
  messageIds: string[];
  deliveredAt?: string;
  readAt?: string;
  lastReadAt?: string;
};

export type PresenceUpdate = { userId: string; isOnline: boolean; lastSeenAt: string | null };
export type TypingUpdate = { conversationId: string; userId: string; isTyping: boolean };

type UserRecord = Prisma.UserGetPayload<{ select: typeof PUBLIC_USER_SELECT }>;

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    isOnline: user.isOnline,
    lastSeenAt: user.lastSeenAt ? user.lastSeenAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  };
}

type ReplyToRecord = {
  id: string;
  body: string | null;
  deletedAt: Date | null;
  sender: { username: string };
};

type MessageRecord = {
  id: string;
  conversationId: string;
  senderId: string;
  clientId: string | null;
  body: string | null;
  attachments: unknown | null;
  replyToId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  sender: SenderSummary;
  replyTo: ReplyToRecord | null;
};

export function toMessageDTO(message: MessageRecord): MessageDTO {
  const deleted = message.deletedAt !== null;
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    clientId: message.clientId,
    body: deleted ? null : message.body,
    attachments: deleted ? null : (message.attachments ?? null),
    replyToId: message.replyToId,
    replyTo: message.replyTo
      ? {
          id: message.replyTo.id,
          body: message.replyTo.deletedAt ? null : message.replyTo.body,
          deletedAt: message.replyTo.deletedAt ? message.replyTo.deletedAt.toISOString() : null,
          senderUsername: message.replyTo.sender.username,
        }
      : null,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt ? message.editedAt.toISOString() : null,
    deletedAt: message.deletedAt ? message.deletedAt.toISOString() : null,
    sender: message.sender,
  };
}

type NotificationRecord = {
  id: string;
  type: NotificationType;
  messageId: string | null;
  payload: unknown | null;
  createdAt: Date;
  readAt: Date | null;
};

export function toNotificationDTO(row: NotificationRecord): NotificationDTO {
  return {
    id: row.id,
    type: row.type,
    messageId: row.messageId,
    payload: row.payload ?? null,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
  };
}
