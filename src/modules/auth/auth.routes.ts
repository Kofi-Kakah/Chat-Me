import { Router } from "express";
import { env } from "../../config/env";
import { requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/error";
import { createRateLimit } from "../../middleware/rate-limit";
import { loginSchema, registerSchema } from "./auth.schemas";
import { getCurrentUser, loginUser, logoutUser, registerUser } from "./auth.service";

const router = Router();
const authLimiter = createRateLimit({ scope: "auth", max: env.AUTH_RATE_LIMIT_MAX });

router.post(
  "/register",
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const result = await registerUser(input);
    res.status(201).json(result);
  }),
);

router.post(
  "/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const result = await loginUser(input);
    res.json(result);
  }),
);

router.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    await logoutUser(req.sessionId as string);
    res.status(204).send();
  }),
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req.user?.id as string);
    res.json({ user });
  }),
);

export default router;
