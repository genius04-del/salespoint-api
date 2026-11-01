import { Router } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";
import { recordAudit } from "../utils/audit";
import { authenticate } from "../middleware/auth";
import { seedDefaultChartOfAccounts } from "../services/seedAccounts";
import { effectivePermissions } from "../services/permissions";
import { sendPasswordResetEmail } from "../services/email";

const router = Router();

const SALT_ROUNDS = 12;

type TokenUser = {
  id: string;
  businessId: string;
  role: string;
  extraPermissions: string[];
  revokedPermissions: string[];
  tokenVersion: number;
};

// The access token carries the user's effective permissions, so a change to a
// user's permissions takes effect when their token is next issued (at login,
// or on refresh — at most 15 minutes later).
function accessTokenFor(user: TokenUser) {
  return signAccessToken({
    userId: user.id,
    businessId: user.businessId,
    role: user.role,
    permissions: effectivePermissions(user.role, user.extraPermissions, user.revokedPermissions),
  });
}

// The refresh token carries the user's tokenVersion; logging out bumps it,
// which invalidates every refresh token issued before.
function refreshTokenFor(user: { id: string; tokenVersion: number }) {
  return signRefreshToken({ userId: user.id, tokenVersion: user.tokenVersion });
}

// ---- POST /auth/register-business ----
// Business onboarding step 1+2: creates the business AND its first
// user as OWNER, in a single transaction so we never end up with
// an orphaned business or a user with no business.
const registerSchema = z.object({
  businessName: z.string().min(2),
  businessType: z.string().min(2).default("general"),
  currency: z.string().length(3).default("GHS"),
  ownerName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().optional(),
  password: z.string().min(8),
});

router.post("/register-business", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { businessName, businessType, currency, ownerName, email, phone, password } =
    parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const business = await tx.business.create({
      data: { name: businessName, businessType, currency },
    });

    const owner = await tx.user.create({
      data: {
        businessId: business.id,
        name: ownerName,
        email,
        phone,
        passwordHash,
        role: "OWNER",
      },
    });

    // Every business starts with a working chart of accounts (rule #16) —
    // Finance automation elsewhere looks these up by fixed code, so this
    // must run before any sale/purchase/expense can post a journal entry.
    await seedDefaultChartOfAccounts(tx, business.id);

    return { business, owner };
  });

  await recordAudit({
    businessId: result.business.id,
    userId: result.owner.id,
    action: "BUSINESS_CREATED",
    entity: "Business",
    entityId: result.business.id,
  });

  const accessToken = accessTokenFor(result.owner);
  const refreshToken = refreshTokenFor(result.owner);

  return res.status(201).json({
    business: { id: result.business.id, name: result.business.name },
    user: { id: result.owner.id, name: result.owner.name, email: result.owner.email, role: result.owner.role },
    accessToken,
    refreshToken,
  });
});

// ---- POST /auth/login ----
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });

  // Same generic error whether the email doesn't exist or the password is
  // wrong, so we don't leak which emails are registered.
  if (!user || !user.isActive) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const accessToken = accessTokenFor(user);
  const refreshToken = refreshTokenFor(user);

  await recordAudit({
    businessId: user.businessId,
    userId: user.id,
    action: "LOGIN",
    entity: "User",
    entityId: user.id,
  });

  return res.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role, businessId: user.businessId },
    accessToken,
    refreshToken,
  });
});

// ---- POST /auth/refresh ----
const refreshSchema = z.object({ refreshToken: z.string() });

router.post("/refresh", async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const { userId, tokenVersion } = verifyRefreshToken(parsed.data.refreshToken);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    // A token issued before logout carries an older tokenVersion and is rejected.
    if (!user || !user.isActive || user.tokenVersion !== (tokenVersion ?? 0)) {
      return res.status(401).json({ error: "Invalid refresh token" });
    }

    return res.json({ accessToken: accessTokenFor(user) });
  } catch {
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

// ---- POST /auth/change-password ----
// For a logged-in user who knows their current password. Bumps
// tokenVersion so every OTHER session is signed out — the standard
// behavior when a password changes, in case the old one was compromised.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

router.post("/change-password", authenticate, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  const valid = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Current password is incorrect" });

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, SALT_ROUNDS);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, tokenVersion: { increment: 1 } },
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "PASSWORD_CHANGED",
    entity: "User",
    entityId: user.id,
  });

  const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  return res.json({
    accessToken: accessTokenFor(updated),
    refreshToken: refreshTokenFor(updated),
    message: "Password changed. Other sessions on this account have been signed out.",
  });
});

// ---- POST /auth/forgot-password ----
// Always returns the same generic message whether or not the email exists
// — confirming or denying an email's existence is itself a privacy leak,
// and that holds regardless of whether sending the email itself succeeds.
const forgotPasswordSchema = z.object({ email: z.string().email() });
const GENERIC_RESET_MESSAGE = "If an account exists for that email, a password reset link has been sent.";

router.post("/forgot-password", async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (user && user.isActive) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: new Date(Date.now() + 30 * 60 * 1000) },
    });

    const resetUrl = `${process.env.PASSWORD_RESET_BASE_URL || "http://localhost:3000/reset-password"}?token=${rawToken}`;

    // Always logged too — handy in development, and means the flow is still
    // testable even with no RESEND_API_KEY configured at all.
    console.log(`[password reset] ${user.email} -> ${resetUrl} (expires in 30 min)`);
    const emailSent = await sendPasswordResetEmail(user.email, resetUrl);

    await recordAudit({
      businessId: user.businessId,
      userId: user.id,
      action: "PASSWORD_RESET_REQUESTED",
      entity: "User",
      entityId: user.id,
      metadata: { emailSent },
    });
  }

  return res.json({ message: GENERIC_RESET_MESSAGE });
});

// ---- POST /auth/reset-password ----
const resetPasswordSchema = z.object({ token: z.string().min(1), newPassword: z.string().min(8) });

router.post("/reset-password", async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const tokenHash = crypto.createHash("sha256").update(parsed.data.token).digest("hex");
  const user = await prisma.user.findFirst({ where: { passwordResetTokenHash: tokenHash } });

  if (!user || !user.passwordResetExpiresAt || user.passwordResetExpiresAt < new Date()) {
    return res.status(400).json({ error: "This reset link is invalid or has expired" });
  }

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, SALT_ROUNDS);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      tokenVersion: { increment: 1 }, // sign out every existing session, including whoever's request this was
    },
  });

  await recordAudit({
    businessId: user.businessId,
    userId: user.id,
    action: "PASSWORD_RESET_COMPLETED",
    entity: "User",
    entityId: user.id,
  });

  return res.json({ message: "Password reset. Please log in with your new password." });
});

// ---- POST /auth/logout ----
// Revokes every refresh token this account has (so it can't get new access
// tokens) and records the logout in the audit log. The current access token
// itself stays valid until it expires (at most 15 minutes) — that is inherent
// to stateless JWTs — so clients should discard it on logout.
router.post("/logout", authenticate, async (req, res) => {
  await prisma.user.update({
    where: { id: req.auth!.userId },
    data: { tokenVersion: { increment: 1 } },
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "LOGOUT",
    entity: "User",
    entityId: req.auth!.userId,
  });

  return res.json({ message: "Logged out. Refresh tokens for this account have been revoked." });
});

// ---- GET /auth/me ----
router.get("/me", authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: { id: true, name: true, email: true, role: true, businessId: true, phone: true },
  });
  if (!user) return res.status(404).json({ error: "User not found" });
  return res.json({ user, permissions: req.auth!.permissions });
});

export default router;
