import { Router } from "express";
import bcrypt from "bcrypt";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { signAccessToken, signRefreshToken } from "../utils/jwt";
import { recordAudit } from "../utils/audit";
import { effectivePermissions } from "../services/permissions";
import { afterFailedPin, lockMinutesLeft, normaliseBusinessCode, PIN_ROLES } from "../services/shifts";

const router = Router();

// Per source address AND per till/staff pair, on top of the per-account
// lockout below, so one person can't walk through every staff number.
const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}:${String(req.body?.businessCode ?? "").toUpperCase()}`,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});
router.use(pinLimiter);

// Compared against when the till code or staff number doesn't exist, so a
// wrong code takes as long as a wrong PIN and reveals nothing by timing.
const DUMMY_HASH = "$2b$10$CwTycUXWue0Thq9StjUM0uJ8S1o0t0bC8KQ6G0y0y0y0y0y0y0y0y";

const schema = z.object({
  businessCode: z.string().min(4).max(12),
  staffNumber: z.number().int().positive(),
  pin: z.string().regex(/^\d{4,6}$/),
});

const BAD = { error: "That till code, staff number or PIN isn't right." };

// ---- POST /auth/pin-login ----
router.post("/", async (req, res) => {
  const parsed = schema.safeParse({ ...req.body, staffNumber: Number(req.body?.staffNumber) });
  if (!parsed.success) return res.status(400).json(BAD);
  const { businessCode, staffNumber, pin } = parsed.data;

  const business = await prisma.business.findFirst({
    where: { shortCode: normaliseBusinessCode(businessCode), isActive: true },
    select: { id: true },
  });
  const user = business
    ? await prisma.user.findFirst({ where: { businessId: business.id, staffNumber } })
    : null;

  if (!user || !user.isActive || !user.pinHash || !(PIN_ROLES as readonly string[]).includes(user.role)) {
    await bcrypt.compare(pin, DUMMY_HASH);
    return res.status(401).json(BAD);
  }

  const wait = lockMinutesLeft(user.pinLockedUntil);
  if (wait > 0) {
    return res.status(429).json({
      error: `Too many wrong PINs. This till login is locked for ${wait} more minute${wait === 1 ? "" : "s"}. Ask a manager to unlock it.`,
    });
  }

  const ok = await bcrypt.compare(pin, user.pinHash);
  if (!ok) {
    const next = afterFailedPin(user.pinFailedAttempts);
    await prisma.user.update({
      where: { id: user.id },
      data: { pinFailedAttempts: next.pinFailedAttempts, pinLockedUntil: next.pinLockedUntil },
    });
    if (next.locked) {
      await recordAudit({ businessId: user.businessId, userId: user.id, action: "PIN_LOCKED", entity: "User", entityId: user.id });
    }
    return res.status(401).json(BAD);
  }

  if (user.pinFailedAttempts !== 0 || user.pinLockedUntil) {
    await prisma.user.update({ where: { id: user.id }, data: { pinFailedAttempts: 0, pinLockedUntil: null } });
  }

  const accessToken = signAccessToken({
    userId: user.id,
    businessId: user.businessId,
    role: user.role,
    permissions: effectivePermissions(user.role, user.extraPermissions, user.revokedPermissions),
  });
  const refreshToken = signRefreshToken({ userId: user.id, tokenVersion: user.tokenVersion });

  await recordAudit({ businessId: user.businessId, userId: user.id, action: "PIN_LOGIN", entity: "User", entityId: user.id });

  return res.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role, businessId: user.businessId },
    accessToken,
    refreshToken,
  });
});

export default router;
