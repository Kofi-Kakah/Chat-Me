import { z } from "zod";

export const USERNAME_REGEX = /^[a-z0-9_.]{3,24}$/;

export const registerSchema = z.object({
  email: z.string().email().max(255),
  username: z
    .string()
    .regex(USERNAME_REGEX, "Username must be 3-24 characters using a-z, 0-9, '_' or '.'"),
  password: z.string().min(8).max(72),
  displayName: z.string().trim().min(1).max(64).optional(),
});

export const loginSchema = z.object({
  identifier: z.string().min(3).max(255),
  password: z.string().min(1).max(72),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
