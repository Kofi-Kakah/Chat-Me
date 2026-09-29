import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/error";
import { listNotificationsSchema, notificationIdSchema } from "./notifications.schemas";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  unreadCount,
} from "./notifications.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const options = listNotificationsSchema.parse(req.query);
    const page = await listNotifications(req.user?.id as string, options);
    res.json(page);
  }),
);

router.get(
  "/unread-count",
  asyncHandler(async (req, res) => {
    const count = await unreadCount(req.user?.id as string);
    res.json({ count });
  }),
);

router.post(
  "/read-all",
  asyncHandler(async (req, res) => {
    const updated = await markAllNotificationsRead(req.user?.id as string);
    res.json({ updated });
  }),
);

router.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const { id } = notificationIdSchema.parse(req.params);
    const notification = await markNotificationRead(req.user?.id as string, id);
    res.json({ notification });
  }),
);

export default router;
