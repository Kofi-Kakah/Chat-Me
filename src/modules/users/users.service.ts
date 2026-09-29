import type { SearchUsersInput, UpdateProfileInput } from "./users.schemas";
import { PUBLIC_USER_SELECT, toPublicUser, type PublicUser } from "../../lib/mappers";
import { prisma } from "../../lib/prisma";
import { ApiError } from "../../middleware/error";

export async function searchUsers(query: SearchUsersInput, meId: string): Promise<PublicUser[]> {
  const users = await prisma.user.findMany({
    where: {
      id: { not: meId },
      OR: [
        { username: { contains: query.q, mode: "insensitive" } },
        { displayName: { contains: query.q, mode: "insensitive" } },
      ],
    },
    select: PUBLIC_USER_SELECT,
    orderBy: { username: "asc" },
    take: query.limit,
  });
  return users.map(toPublicUser);
}

export async function getUserProfile(username: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { username: username.toLowerCase() },
    select: PUBLIC_USER_SELECT,
  });
  if (!user) throw new ApiError(404, "user_not_found", "User not found");
  return toPublicUser(user);
}

export async function updateProfile(
  userId: string,
  data: UpdateProfileInput,
): Promise<PublicUser> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      displayName: data.displayName,
      bio: data.bio,
      avatarUrl: data.avatarUrl,
    },
    select: PUBLIC_USER_SELECT,
  });
  return toPublicUser(user);
}
