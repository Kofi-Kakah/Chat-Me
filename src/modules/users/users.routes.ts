import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/error";
import { searchUsersSchema, updateProfileSchema } from "./users.schemas";
import { getUserProfile, searchUsers, updateProfile } from "./users.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/search",
  asyncHandler(async (req, res) => {
    const query = searchUsersSchema.parse(req.query);
    const users = await searchUsers(query, req.user?.id as string);
    res.json({ users });
  }),
);

router.get(
  "/me",
  asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  }),
);

router.patch(
  "/me",
  asyncHandler(async (req, res) => {
    const data = updateProfileSchema.parse(req.body);
    const user = await updateProfile(req.user?.id as string, data);
    res.json({ user });
  }),
);

router.get(
  "/:username",
  asyncHandler(async (req, res) => {
    const user = await getUserProfile(req.params.username as string);
    res.json({ user });
  }),
);

export default router;
