import { compare, hash } from "bcryptjs";
import { env } from "../config/env";

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, env.BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, passwordHash: string): Promise<boolean> {
  return compare(plain, passwordHash);
}
