import { z } from "zod";

export const listMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export const sendMessageSchema = z.object({
  conversationId: z.string().min(1),
  body: z.string().trim().min(1).max(4000).optional(),
  attachments: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
  replyToId: z.string().min(1).nullish(),
  clientId: z.string().min(1).max(128).nullish(),
});

export const sendMessageBodySchema = sendMessageSchema.omit({ conversationId: true });

export const editMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

export const messageIdSchema = z.object({
  id: z.string().min(1),
});

export const receiptSchema = z.object({
  conversationId: z.string().min(1),
  messageIds: z.array(z.string().min(1)).max(200).optional(),
});

export const readReceiptSchema = receiptSchema.extend({
  upToMessageId: z.string().min(1).optional(),
});

export const receiptOptionsSchema = receiptSchema.omit({ conversationId: true });

export const readOptionsSchema = readReceiptSchema.omit({ conversationId: true });

export const typingEventSchema = z.object({
  conversationId: z.string().min(1),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type ListMessagesInput = z.infer<typeof listMessagesSchema>;
