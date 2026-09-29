import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/error";
import { editMessageSchema, messageIdSchema } from "./messages.schemas";
import { deleteMessage, editMessage, getMessage } from "./messages.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = messageIdSchema.parse(req.params);
    const message = await getMessage(req.user?.id as string, id);
    res.json({ message });
  }),
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = messageIdSchema.parse(req.params);
    const { body } = editMessageSchema.parse(req.body);
    const message = await editMessage(req.user?.id as string, id, body);
    res.json({ message });
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = messageIdSchema.parse(req.params);
    const message = await deleteMessage(req.user?.id as string, id);
    res.json({ message });
  }),
);

export default router;
