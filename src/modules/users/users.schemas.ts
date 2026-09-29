import { z } from "zod";

export const searchUsersSchema = z.object({
  q: z.string().trim().min(1).max(50),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  bio: z.string().trim().min(1).max(500).optional(),
  avatarUrl: z.string().max(2048).nullable().optional(),
});

export type SearchUsersInput = z.infer<typeof searchUsersSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
