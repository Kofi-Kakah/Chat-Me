import { EventEmitter } from "node:events";
import type { ConversationDTO, MessageDTO, NotificationDTO, ReceiptUpdate } from "./mappers";

/**
 * Domain events emitted by REST/realtime services. The socket layer subscribes
 * to these and translates them into Socket.IO broadcasts, keeping business
 * logic decoupled from transport concerns.
 */
export interface RealtimeEventMap {
  "message:new": { conversationId: string; message: MessageDTO };
  "message:update": { conversationId: string; message: MessageDTO };
  "receipts:update": ReceiptUpdate;
  "conversation:created": { conversation: ConversationDTO; userIds: string[] };
  "conversation:updated": { conversation: ConversationDTO; userIds: string[] };
  "conversation:deleted": { conversationId: string; userIds: string[] };
  "conversation:member:left": { conversationId: string; userId: string; reason: "left" | "removed" };
  "conversation:read": { conversationId: string; userId: string; lastReadAt: string };
  "notification:new": { userId: string; notification: NotificationDTO };
  "session:revoked": { sessionId: string };
}

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export function emitBus<E extends keyof RealtimeEventMap>(
  event: E,
  payload: RealtimeEventMap[E],
): void {
  emitter.emit(event, payload);
}

export function onBus<E extends keyof RealtimeEventMap>(
  event: E,
  handler: (payload: RealtimeEventMap[E]) => void | Promise<void>,
): void {
  emitter.on(event, (payload: RealtimeEventMap[E]) => {
    void handler(payload);
  });
}
