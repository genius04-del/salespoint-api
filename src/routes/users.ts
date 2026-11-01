import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { authenticate, authorize, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import { PERMISSIONS, ROLE_DEFAULTS, ALL_PERMISSIONS, effectivePermissions } from "../services/permissions";

const router = Router();
const SALT_ROUNDS = 12;

const ROLES = ["OWNER", "MANAGER", "CASHIER", "INVENTORY_OFFICER", "ACCOUNTANT", "KITCHEN_STAFF"] as const;

// Every route below requires auth. req.auth.businessId (from the verified
// JWT) is what scopes every query — never a businessId from the client.
router.use(authenticate);

// ---- GET /staff ---- list staff in my business
router.get("/", requirePermission("staff.manage"), async (req, res) => {
  const staff = await prisma.user.findMany({
    where: { businessId: req.auth!.businessId },
    select: { id: true, name: true, email: true, phone: true, role: true, isActive: true, extraPermissions: true, revokedPermissions: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return res.json({ staff });
});

// ---- POST /staff ---- add a staff member to my business
const createStaffSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().optional(),
  password: z.string().min(8),
  role: z.enum(ROLES),
});

router.post("/", requirePermission("staff.manage"), async (req, res) => {
  const parsed = createStaffSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Only an OWNER may create another OWNER.
  if (parsed.data.role === "OWNER" && req.auth!.role !== "OWNER") {
    return res.status(403).json({ error: "Only an owner can create another owner" });
  }

  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) return res.status(409).json({ error: "Email already in use" });

  const passwordHash = await bcrypt.hash(parsed.data.password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      businessId: req.auth!.businessId,
      name: parsed.data.name,
      email: parsed.data.email,
      phone: parsed.data.phone,
      passwordHash,
      role: parsed.data.role,
    },
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "STAFF_CREATED",
    entity: "User",
    entityId: user.id,
    metadata: { role: user.role },
  });

  return res.status(201).json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

// ---- PATCH /staff/:id ---- update role/active status (tenant-scoped)
const updateStaffSchema = z.object({
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
  name: z.string().min(2).optional(),
  phone: z.string().optional(),
});

router.patch("/:id", requirePermission("staff.manage"), async (req, res) => {
  const parsed = updateStaffSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Confirm the target user belongs to the caller's business BEFORE updating,
  // so a manager in business A can never touch a user in business B.
  const target = await prisma.user.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
  });
  if (!target) return res.status(404).json({ error: "Staff member not found" });

  if (parsed.data.role === "OWNER" && req.auth!.role !== "OWNER") {
    return res.status(403).json({ error: "Only an owner can promote to owner" });
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: parsed.data,
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "STAFF_UPDATED",
    entity: "User",
    entityId: updated.id,
    metadata: parsed.data,
  });

  return res.json({
    user: { id: updated.id, name: updated.name, role: updated.role, isActive: updated.isActive },
  });
});

// ---- GET /staff/permissions ---- the full permission catalogue and each role's defaults
router.get("/permissions", requirePermission("staff.manage"), (_req, res) => {
  return res.json({ permissions: PERMISSIONS, roleDefaults: ROLE_DEFAULTS });
});

// ---- GET /staff/:id/permissions ---- what one person can do, and why
router.get("/:id/permissions", requirePermission("staff.manage"), async (req, res) => {
  const user = await prisma.user.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
    select: { id: true, name: true, role: true, extraPermissions: true, revokedPermissions: true },
  });
  if (!user) return res.status(404).json({ error: "Staff member not found" });

  return res.json({
    user: { id: user.id, name: user.name, role: user.role },
    roleDefaults: ROLE_DEFAULTS[user.role] ?? [],
    granted: user.extraPermissions,
    revoked: user.revokedPermissions,
    effective: effectivePermissions(user.role, user.extraPermissions, user.revokedPermissions),
  });
});

// ---- PUT /staff/:id/permissions ---- Owner only
// Replaces this person's overrides: `grant` adds permissions their role doesn't
// have; `revoke` removes ones it does. Send the full lists you want.
const permissionsSchema = z.object({
  grant: z.array(z.string()).default([]),
  revoke: z.array(z.string()).default([]),
});

router.put("/:id/permissions", authorize("OWNER"), async (req, res) => {
  const parsed = permissionsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const unknown = [...parsed.data.grant, ...parsed.data.revoke].filter(
    (p) => !ALL_PERMISSIONS.includes(p as any)
  );
  if (unknown.length > 0) {
    return res.status(400).json({ error: `Unknown permission(s): ${unknown.join(", ")}`, valid: ALL_PERMISSIONS });
  }
  const overlap = parsed.data.grant.filter((p) => parsed.data.revoke.includes(p));
  if (overlap.length > 0) {
    return res.status(400).json({ error: `Cannot both grant and revoke: ${overlap.join(", ")}` });
  }

  const target = await prisma.user.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
  });
  if (!target) return res.status(404).json({ error: "Staff member not found" });
  if (target.role === "OWNER") {
    return res.status(400).json({ error: "An owner always has every permission and can't be restricted" });
  }

  // Store only real deviations from the role's defaults, so the record stays meaningful.
  const defaults = new Set<string>(ROLE_DEFAULTS[target.role] ?? []);
  const granted = [...new Set(parsed.data.grant)].filter((p) => !defaults.has(p));
  const revoked = [...new Set(parsed.data.revoke)].filter((p) => defaults.has(p));

  await prisma.user.update({
    where: { id: target.id },
    data: { extraPermissions: granted, revokedPermissions: revoked },
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "PERMISSIONS_CHANGED",
    entity: "User",
    entityId: target.id,
    metadata: {
      before: { granted: target.extraPermissions, revoked: target.revokedPermissions },
      after: { granted, revoked },
    },
  });

  return res.json({
    user: { id: target.id, name: target.name, role: target.role },
    granted,
    revoked,
    effective: effectivePermissions(target.role, granted, revoked),
    note: "Takes effect the next time this person's access token is issued (they log in again, or within 15 minutes).",
  });
});

export default router;
