import { z } from "zod";

export const createDirectSchema = z.object({
  userId: z.string().min(1),
});

export const createGroupSchema = z.object({
  title: z.string().trim().min(1).max(80),
  imageUrl: z.string().max(2048).nullable().optional(),
  memberIds: z.array(z.string().min(1)).min(1).max(100),
});

export const updateConversationSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  imageUrl: z.string().max(2048).nullable().optional(),
});

export const addMembersSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(50),
});

export const conversationIdSchema = z.object({
  id: z.string().min(1),
});

export const memberParamsSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
});

export type CreateDirectInput = z.infer<typeof createDirectSchema>;
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
