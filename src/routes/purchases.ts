import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import { applyInventoryMovement } from "../services/inventory";
import { createJournalEntry, accountCodeForPaymentMethod, ACCOUNT_CODES } from "../services/journal";

const router = Router();
router.use(authenticate);


function derivePaymentStatus(totalCost: Prisma.Decimal, amountPaid: Prisma.Decimal) {
  if (amountPaid.lte(0)) return "UNPAID" as const;
  if (amountPaid.gte(totalCost)) return "PAID" as const;
  return "PARTIAL" as const;
}

const purchaseItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive(),
  costPrice: z.number().min(0),
});

const createPurchaseSchema = z.object({
  supplierId: z.string(),
  items: z.array(purchaseItemSchema).min(1),
  amountPaid: z.number().min(0).default(0),
  notes: z.string().optional(),
});

// ---- POST /purchases ---- record stock coming in from a supplier
router.post("/", requirePermission("purchases.manage"), async (req, res) => {
  const parsed = createPurchaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { supplierId, items, amountPaid, notes } = parsed.data;

  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, businessId: req.auth!.businessId },
  });
  if (!supplier) return res.status(400).json({ error: "Supplier not found for this business" });

  const productIds = items.map((i) => i.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, businessId: req.auth!.businessId },
  });
  if (products.length !== new Set(productIds).size) {
    return res.status(400).json({ error: "One or more products not found for this business" });
  }
  const productMap = new Map(products.map((p) => [p.id, p]));

  let totalCost = new Prisma.Decimal(0);
  const lineData = items.map((item) => {
    const product = productMap.get(item.productId)!;
    const lineTotal = new Prisma.Decimal(item.costPrice).mul(item.quantity);
    totalCost = totalCost.add(lineTotal);
    return { product, item, lineTotal };
  });

  const paidDecimal = new Prisma.Decimal(amountPaid);
  if (paidDecimal.gt(totalCost)) {
    return res.status(400).json({ error: "amountPaid cannot exceed the purchase total" });
  }

  const purchase = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const created = await tx.purchase.create({
      data: {
        businessId: req.auth!.businessId,
        supplierId,
        recordedById: req.auth!.userId,
        totalCost,
        amountPaid: paidDecimal,
        paymentStatus: derivePaymentStatus(totalCost, paidDecimal),
        notes,
        items: {
          create: lineData.map((l) => ({
            productId: l.product.id,
            productName: l.product.name,
            costPrice: l.item.costPrice,
            quantity: l.item.quantity,
            lineTotal: l.lineTotal,
          })),
        },
        ...(paidDecimal.gt(0)
          ? {
              payments: {
                create: [
                  {
                    businessId: req.auth!.businessId,
                    amount: paidDecimal,
                    method: "CASH",
                    notes: "Initial payment at purchase time",
                    userId: req.auth!.userId,
                  },
                ],
              },
            }
          : {}),
      },
      include: { items: true, payments: true },
    });

    // Stock increases for every line, via the same choke-point sales/opening-stock use.
    for (const l of lineData) {
      await applyInventoryMovement({
        tx,
        businessId: req.auth!.businessId,
        productId: l.product.id,
        type: "PURCHASE",
        quantityChange: l.item.quantity,
        reason: `Purchase from ${supplier.name}`,
        reference: created.id,
        userId: req.auth!.userId,
      });
    }

    // Recognize the full liability first (Debit Inventory, Credit Accounts
    // Payable), then — if any amount was paid immediately — a second entry
    // reduces that liability the same way a later /payments call would.
    await createJournalEntry({
      tx,
      businessId: req.auth!.businessId,
      description: `Purchase from ${supplier.name}`,
      sourceType: "PURCHASE",
      sourceId: created.id,
      createdById: req.auth!.userId,
      lines: [
        { accountCode: ACCOUNT_CODES.INVENTORY, debit: Number(totalCost) },
        { accountCode: ACCOUNT_CODES.ACCOUNTS_PAYABLE, credit: Number(totalCost) },
      ],
    });

    if (paidDecimal.gt(0)) {
      await createJournalEntry({
        tx,
        businessId: req.auth!.businessId,
        description: `Initial payment on purchase from ${supplier.name}`,
        sourceType: "PURCHASE_PAYMENT",
        sourceId: created.id,
        createdById: req.auth!.userId,
        lines: [
          { accountCode: ACCOUNT_CODES.ACCOUNTS_PAYABLE, debit: Number(paidDecimal) },
          { accountCode: accountCodeForPaymentMethod("CASH"), credit: Number(paidDecimal) },
        ],
      });
    }

    return created;
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "PURCHASE_RECORDED",
    entity: "Purchase",
    entityId: purchase.id,
    metadata: { supplierId, totalCost, amountPaid },
  });

  return res.status(201).json({ purchase });
});

// ---- GET /purchases ---- filters: supplierId, from, to
router.get("/", requirePermission("purchases.view"), async (req, res) => {
  const { supplierId, from, to } = req.query;
  const where: any = { businessId: req.auth!.businessId };
  if (supplierId) where.supplierId = String(supplierId);
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(String(from));
    if (to) where.createdAt.lte = new Date(String(to));
  }

  const purchases = await prisma.purchase.findMany({
    where,
    include: { supplier: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return res.json({ purchases });
});

// ---- GET /purchases/:id ----
router.get("/:id", requirePermission("purchases.view"), async (req, res) => {
  const purchase = await prisma.purchase.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
    include: {
      items: true,
      payments: { orderBy: { createdAt: "desc" } },
      supplier: { select: { id: true, name: true } },
    },
  });
  if (!purchase) return res.status(404).json({ error: "Purchase not found" });
  return res.json({ purchase });
});

// ---- POST /purchases/:id/payments ---- record a payment toward the balance
const paymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(["CASH", "MOBILE_MONEY", "BANK_TRANSFER", "OTHER"]),
  reference: z.string().optional(),
  notes: z.string().optional(),
});

router.post("/:id/payments", requirePermission("purchases.pay"), async (req, res) => {
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const purchase = await prisma.purchase.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
  });
  if (!purchase) return res.status(404).json({ error: "Purchase not found" });

  const newAmountPaid = purchase.amountPaid.add(parsed.data.amount);
  if (newAmountPaid.gt(purchase.totalCost)) {
    return res.status(400).json({
      error: `Payment exceeds outstanding balance (owed: ${purchase.totalCost.sub(purchase.amountPaid)})`,
    });
  }

  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.purchasePayment.create({
      data: {
        businessId: req.auth!.businessId,
        purchaseId: purchase.id,
        amount: parsed.data.amount,
        method: parsed.data.method,
        reference: parsed.data.reference,
        notes: parsed.data.notes,
        userId: req.auth!.userId,
      },
    });

    await createJournalEntry({
      tx,
      businessId: req.auth!.businessId,
      description: `Payment on purchase ${purchase.id}`,
      sourceType: "PURCHASE_PAYMENT",
      sourceId: purchase.id,
      createdById: req.auth!.userId,
      lines: [
        { accountCode: ACCOUNT_CODES.ACCOUNTS_PAYABLE, debit: parsed.data.amount },
        { accountCode: accountCodeForPaymentMethod(parsed.data.method), credit: parsed.data.amount },
      ],
    });

    return tx.purchase.update({
      where: { id: purchase.id },
      data: {
        amountPaid: newAmountPaid,
        paymentStatus: derivePaymentStatus(purchase.totalCost, newAmountPaid),
      },
      include: { payments: true },
    });
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "SUPPLIER_PAYMENT_RECORDED",
    entity: "Purchase",
    entityId: purchase.id,
    metadata: { amount: parsed.data.amount, method: parsed.data.method },
  });

  return res.status(201).json({ purchase: updated });
});

export default router;
