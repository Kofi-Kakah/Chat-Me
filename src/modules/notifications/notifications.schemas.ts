import { z } from "zod";

export const listNotificationsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().optional(),
  unreadOnly: z
    .preprocess((value) => value === "true" || value === true, z.boolean())
    .default(false),
});

export const notificationIdSchema = z.object({
  id: z.string().min(1),
});

export type ListNotificationsInput = z.infer<typeof listNotificationsSchema>;
