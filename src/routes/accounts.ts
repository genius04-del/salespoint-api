import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, authorize, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import { seedDefaultChartOfAccounts } from "../services/seedAccounts";

const router = Router();
router.use(authenticate);


// ---- GET /accounts ----
router.get("/", requirePermission("finance.view"), async (req, res) => {
  const accounts = await prisma.account.findMany({
    where: { businessId: req.auth!.businessId },
    orderBy: { code: "asc" },
  });
  return res.json({ accounts });
});

// ---- POST /accounts/seed-defaults ----
// One-time backfill for businesses registered before the Chart of Accounts
// existed. Safe to call repeatedly — only adds codes that are missing.
router.post("/seed-defaults", authorize("OWNER"), async (req, res) => {
  const existing = await prisma.account.findMany({
    where: { businessId: req.auth!.businessId },
    select: { code: true },
  });
  if (existing.length > 0) {
    return res.status(409).json({
      error: `This business already has ${existing.length} account(s). Use POST /accounts to add any missing ones individually.`,
    });
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await seedDefaultChartOfAccounts(tx, req.auth!.businessId);
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "CHART_OF_ACCOUNTS_SEEDED",
    entity: "Account",
  });

  const accounts = await prisma.account.findMany({
    where: { businessId: req.auth!.businessId },
    orderBy: { code: "asc" },
  });
  return res.status(201).json({ accounts });
});

// ---- POST /accounts ---- add a custom account (rule #16: businesses can extend the COA)
const createSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]),
  normalBalance: z.enum(["DEBIT", "CREDIT"]),
});

router.post("/", requirePermission("accounts.manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const account = await prisma.account.create({
      data: { businessId: req.auth!.businessId, ...parsed.data, isSystem: false },
    });

    await recordAudit({
      businessId: req.auth!.businessId,
      userId: req.auth!.userId,
      action: "ACCOUNT_CREATED",
      entity: "Account",
      entityId: account.id,
    });

    return res.status(201).json({ account });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "An account with this code or name already exists" });
    }
    throw err;
  }
});

// ---- PATCH /accounts/:id ----
// Deliberately cannot change `type`, `normalBalance`, or `code` on a system
// account — journal automation depends on those staying stable, and
// changing an account's type after it has postings would corrupt history.
const updateSchema = z.object({
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

router.patch("/:id", requirePermission("accounts.manage"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const account = await prisma.account.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
  });
  if (!account) return res.status(404).json({ error: "Account not found" });

  const updated = await prisma.account.update({ where: { id: account.id }, data: parsed.data });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "ACCOUNT_UPDATED",
    entity: "Account",
    entityId: updated.id,
    metadata: parsed.data,
  });

  return res.json({ account: updated });
});

export default router;
