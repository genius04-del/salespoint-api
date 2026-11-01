import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import { generateBusinessCode, PIN_ROLES, validatePin } from "../services/shifts";

const router = Router();
router.use(authenticate, requirePermission("staff.manage"));

async function ensureBusinessCode(businessId: string): Promise<string> {
  const existing = await prisma.business.findUnique({ where: { id: businessId }, select: { shortCode: true } });
  if (existing?.shortCode) return existing.shortCode;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateBusinessCode();
    const taken = await prisma.business.findFirst({ where: { shortCode: code }, select: { id: true } });
    if (taken) continue;
    await prisma.business.update({ where: { id: businessId }, data: { shortCode: code } });
    return code;
  }
  throw new Error("Could not generate a till code");
}

// ---- GET /till-access ---- the till code and who can use a PIN
router.get("/", async (req, res) => {
  const businessId = req.auth!.businessId;
  const [businessCode, staff] = await Promise.all([
    ensureBusinessCode(businessId),
    prisma.user.findMany({
      where: { businessId, role: { in: [...PIN_ROLES] }, isActive: true },
      select: { id: true, name: true, role: true, staffNumber: true, pinHash: true, pinLockedUntil: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const now = Date.now();
  return res.json({
    businessCode,
    staff: staff.map((s: any) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      staffNumber: s.staffNumber,
      hasPin: !!s.pinHash,
      locked: !!s.pinLockedUntil && s.pinLockedUntil.getTime() > now,
    })),
  });
});

// ---- PUT /till-access/:userId/pin ---- set or reset a PIN
router.put("/:userId/pin", async (req, res) => {
  const parsed = z.object({ pin: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a PIN" });
  const problem = validatePin(parsed.data.pin);
  if (problem) return res.status(400).json({ error: problem });

  const businessId = req.auth!.businessId;
  const user = await prisma.user.findFirst({ where: { id: req.params.userId, businessId } });
  if (!user) return res.status(404).json({ error: "Staff member not found" });
  if (!(PIN_ROLES as readonly string[]).includes(user.role)) {
    return res.status(400).json({ error: "Only cashiers and kitchen staff use a till PIN. Owners and managers sign in with their password." });
  }

  const pinHash = await bcrypt.hash(parsed.data.pin, 10);
  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    let staffNumber = user.staffNumber;
    if (staffNumber == null) {
      // Lock the business row so two managers can't hand out the same number.
      await tx.$queryRaw`SELECT id FROM businesses WHERE id = ${businessId} FOR UPDATE`;
      const last = await tx.user.findFirst({
        where: { businessId, staffNumber: { not: null } },
        orderBy: { staffNumber: "desc" },
        select: { staffNumber: true },
      });
      staffNumber = (last?.staffNumber ?? 0) + 1;
    }
    return tx.user.update({
      where: { id: user.id },
      data: { pinHash, staffNumber, pinFailedAttempts: 0, pinLockedUntil: null },
      select: { id: true, name: true, staffNumber: true },
    });
  });

  await recordAudit({ businessId, userId: req.auth!.userId, action: "PIN_SET", entity: "User", entityId: user.id });
  return res.json({ user: updated });
});

// ---- DELETE /till-access/:userId/pin ---- switch PIN login off for them
router.delete("/:userId/pin", async (req, res) => {
  const businessId = req.auth!.businessId;
  const user = await prisma.user.findFirst({ where: { id: req.params.userId, businessId } });
  if (!user) return res.status(404).json({ error: "Staff member not found" });
  await prisma.user.update({ where: { id: user.id }, data: { pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null } });
  await recordAudit({ businessId, userId: req.auth!.userId, action: "PIN_REMOVED", entity: "User", entityId: user.id });
  return res.json({ message: "PIN removed" });
});

// ---- POST /till-access/:userId/unlock ----
router.post("/:userId/unlock", async (req, res) => {
  const businessId = req.auth!.businessId;
  const user = await prisma.user.findFirst({ where: { id: req.params.userId, businessId } });
  if (!user) return res.status(404).json({ error: "Staff member not found" });
  await prisma.user.update({ where: { id: user.id }, data: { pinFailedAttempts: 0, pinLockedUntil: null } });
  await recordAudit({ businessId, userId: req.auth!.userId, action: "PIN_UNLOCKED", entity: "User", entityId: user.id });
  return res.json({ message: "Unlocked" });
});

export default router;
