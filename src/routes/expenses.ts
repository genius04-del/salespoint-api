import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import { createJournalEntry } from "../services/journal";

const router = Router();
router.use(authenticate);


const createSchema = z.object({
  categoryAccountId: z.string(),
  paymentAccountId: z.string(),
  amount: z.number().positive(),
  description: z.string().optional(),
  reference: z.string().optional(),
  date: z.string().datetime().optional(),
});

// ---- POST /expenses ----
router.post("/", requirePermission("expenses.manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { categoryAccountId, paymentAccountId, amount, description, reference, date } = parsed.data;

  const [categoryAccount, paymentAccount] = await Promise.all([
    prisma.account.findFirst({ where: { id: categoryAccountId, businessId: req.auth!.businessId } }),
    prisma.account.findFirst({ where: { id: paymentAccountId, businessId: req.auth!.businessId } }),
  ]);
  if (!categoryAccount) return res.status(400).json({ error: "Category account not found for this business" });
  if (!paymentAccount) return res.status(400).json({ error: "Payment account not found for this business" });
  if (categoryAccount.type !== "EXPENSE") {
    return res.status(400).json({ error: "categoryAccountId must reference an EXPENSE-type account" });
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Debit the expense category, credit wherever the money came from.
    const entry = await createJournalEntry({
      tx,
      businessId: req.auth!.businessId,
      description: description || `Expense: ${categoryAccount.name}`,
      sourceType: "EXPENSE",
      createdById: req.auth!.userId,
      entryDate: date ? new Date(date) : undefined,
      lines: [
        { accountCode: categoryAccount.code, debit: amount },
        { accountCode: paymentAccount.code, credit: amount },
      ],
    });

    const expense = await tx.expense.create({
      data: {
        businessId: req.auth!.businessId,
        categoryAccountId,
        paymentAccountId,
        amount,
        description,
        reference,
        recordedById: req.auth!.userId,
        journalEntryId: entry.id,
        ...(date ? { createdAt: new Date(date) } : {}),
      },
    });

    return { expense, entry };
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "EXPENSE_RECORDED",
    entity: "Expense",
    entityId: result.expense.id,
    metadata: { amount, categoryAccountId, paymentAccountId },
  });

  return res.status(201).json(result);
});

// ---- GET /expenses ----
router.get("/", requirePermission("expenses.manage"), async (req, res) => {
  const { from, to, categoryAccountId } = req.query;
  const where: any = { businessId: req.auth!.businessId };
  if (categoryAccountId) where.categoryAccountId = String(categoryAccountId);
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(String(from));
    if (to) where.createdAt.lte = new Date(String(to));
  }

  const expenses = await prisma.expense.findMany({
    where,
    include: {
      categoryAccount: { select: { id: true, name: true, code: true } },
      paymentAccount: { select: { id: true, name: true, code: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return res.json({ expenses });
});

export default router;
