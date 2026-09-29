import type {
  ConversationDTO,
  MessageDTO,
  NotificationDTO,
  PresenceUpdate,
  ReceiptUpdate,
  TypingUpdate,
} from "../lib/mappers";

/** Room helpers: one room per user (user-scoped events) and per conversation. */
export const ROOM = {
  user: (userId: string) => `user:${userId}`,
  session: (sessionId: string) => `session:${sessionId}`,
  conversation: (conversationId: string) => `conversation:${conversationId}`,
};

export const C2S = {
  messageSend: "message:send",
  messageDelivered: "message:delivered",
  messageRead: "message:read",
  typingStart: "typing:start",
  typingStop: "typing:stop",
  presenceHeartbeat: "presence:heartbeat",
} as const;

export const S2C = {
  messageNew: "message:new",
  messageUpdate: "message:update",
  receiptsUpdate: "receipts:update",
  typingUpdate: "typing:update",
  conversationNew: "conversation:new",
  conversationUpdated: "conversation:updated",
  conversationRemoved: "conversation:removed",
  conversationRead: "conversation:read",
  presenceUpdate: "presence:update",
  presenceSnapshot: "presence:snapshot",
  notificationNew: "notification:new",
} as const;

export interface SocketAckSuccess<T> {
  ok: true;
  data: T;
}

export interface SocketAckFailure {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

export type SocketAck<T> = SocketAckSuccess<T> | SocketAckFailure;

export interface ClientToServerEvents {
  "message:send": (
    payload: unknown,
    ack?: (response: SocketAck<MessageDTO>) => void,
  ) => void;
  "message:delivered": (
    payload: unknown,
    ack?: (response: SocketAck<ReceiptUpdate>) => void,
  ) => void;
  "message:read": (
    payload: unknown,
    ack?: (response: SocketAck<ReceiptUpdate>) => void,
  ) => void;
  "typing:start": (
    payload: unknown,
    ack?: (response: SocketAck<{ conversationId: string }>) => void,
  ) => void;
  "typing:stop": (
    payload: unknown,
    ack?: (response: SocketAck<{ conversationId: string }>) => void,
  ) => void;
  "presence:heartbeat": (payload?: unknown) => void;
}

export interface ServerToClientEvents {
  "message:new": (payload: { message: MessageDTO }) => void;
  "message:update": (payload: { message: MessageDTO }) => void;
  "receipts:update": (payload: ReceiptUpdate) => void;
  "typing:update": (payload: TypingUpdate) => void;
  "conversation:new": (payload: { conversation: ConversationDTO }) => void;
  "conversation:updated": (payload: { conversation: ConversationDTO }) => void;
  "conversation:removed": (payload: {
    conversationId: string;
    reason: "left" | "removed" | "deleted";
  }) => void;
  "conversation:read": (payload: {
    conversationId: string;
    userId: string;
    lastReadAt: string;
  }) => void;
  "presence:update": (payload: PresenceUpdate) => void;
  /**
   * Presence of every conversation partner, sent once on connect. The
   * incremental `presence:update` events only describe changes, so a client that
   * has just connected has no other way to learn who is already online.
   */
  "presence:snapshot": (payload: { users: PresenceUpdate[] }) => void;
  "notification:new": (payload: { notification: NotificationDTO }) => void;
}

declare module "socket.io" {
  interface SocketData {
    userId: string;
    sessionId: string;
    username: string;
    convIds: Set<string>;
  }
}
