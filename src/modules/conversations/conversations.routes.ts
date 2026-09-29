import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/error";
import {
  addMembersSchema,
  conversationIdSchema,
  createDirectSchema,
  createGroupSchema,
  memberParamsSchema,
  updateConversationSchema,
} from "./conversations.schemas";
import {
  addMembers,
  createDirectConversation,
  createGroupConversation,
  deleteConversation,
  getConversation,
  leaveConversation,
  listConversations,
  removeMember,
  updateConversation,
} from "./conversations.service";
import { listMessagesSchema, receiptOptionsSchema, readOptionsSchema, sendMessageBodySchema } from "../messages/messages.schemas";
import { listMessages, markDelivered, markRead, sendMessage } from "../messages/messages.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const conversations = await listConversations(req.user?.id as string);
    res.json({ conversations });
  }),
);

router.post(
  "/direct",
  asyncHandler(async (req, res) => {
    const { userId } = createDirectSchema.parse(req.body);
    const conversation = await createDirectConversation(req.user?.id as string, userId);
    res.status(201).json({ conversation });
  }),
);

router.post(
  "/group",
  asyncHandler(async (req, res) => {
    const input = createGroupSchema.parse(req.body);
    const conversation = await createGroupConversation(req.user?.id as string, input);
    res.status(201).json({ conversation });
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = conversationIdSchema.parse(req.params);
    const conversation = await getConversation(req.user?.id as string, id);
    res.json({ conversation });
  }),
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = conversationIdSchema.parse(req.params);
    const data = updateConversationSchema.parse(req.body);
    const conversation = await updateConversation(req.user?.id as string, id, data);
    res.json({ conversation });
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = conversationIdSchema.parse(req.params);
    await deleteConversation(req.user?.id as string, id);
    res.status(204).send();
  }),
);

router.post(
  "/:id/members",
  asyncHandler(async (req, res) => {
    const { id } = conversationIdSchema.parse(req.params);
    const { userIds } = addMembersSchema.parse(req.body);
    const conversation = await addMembers(req.user?.id as string, id, userIds);
    res.json({ conversation });
  }),
);

router.delete(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    const { id, userId } = memberParamsSchema.parse(req.params);
    const conversation = await removeMember(req.user?.id as string, id, userId);
    res.json({ conversation });
  }),
);

router.post(
  "/:id/leave",
  asyncHandler(async (req, res) => {
    const { id } = conversationIdSchema.parse(req.params);
    await leaveConversation(req.user?.id as string, id);
    res.status(204).send();
  }),
);

router.get(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    const { id } = conversationIdSchema.parse(req.params);
    const options = listMessagesSchema.parse(req.query);
    const page = await listMessages(req.user?.id as string, id, options);
    res.json(page);
  }),
);

router.post(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    const { id } = conversationIdSchema.parse(req.params);
    const input = sendMessageBodySchema.parse(req.body);
    const message = await sendMessage(req.user as never, id, input);
    res.status(201).json({ message });
  }),
);

router.post(
  "/:id/delivered",
  asyncHandler(async (req, res) => {
    const { id } = conversationIdSchema.parse(req.params);
    const { messageIds } = receiptOptionsSchema.parse(req.body ?? {});
    const receipt = await markDelivered(req.user?.id as string, id, messageIds);
    res.json(receipt);
  }),
);

router.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const { id } = conversationIdSchema.parse(req.params);
    const input = readOptionsSchema.parse(req.body ?? {});
    const receipt = await markRead(req.user?.id as string, id, input);
    res.json(receipt);
  }),
);

export default router;
