import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import { applyProductStock } from "../services/productStock";
import { priceSaleItems, nextReceiptNumber, mapPricingError } from "../services/salePricing";
import { createRefund } from "../services/paystack";
import { getBusinessPaystackSecretKey, PaystackNotConfiguredError } from "../services/businessPaystackKeys";
import { postSaleJournalEntry, postSaleReversalJournalEntry } from "../services/saleJournal";

const router = Router();
router.use(authenticate);

// Everyone who can operate the POS can create sales; cancellation is
// restricted below since it reverses money and stock.

// Manual (non-Paystack) methods are confirmed immediately because the
// cashier is directly handling cash/MoMo/transfer at the counter.
// PAYSTACK is deliberately rejected here — see checkout handler below.
const MANUAL_METHODS = ["CASH", "MOBILE_MONEY", "BANK_TRANSFER", "OTHER"] as const;

const saleItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive(),
  discount: z.number().min(0).default(0), // flat discount amount for this line
});

const checkoutSchema = z.object({
  items: z.array(saleItemSchema).min(1),
  customerId: z.string().optional(),
  paymentMethod: z.enum(["CASH", "MOBILE_MONEY", "BANK_TRANSFER", "PAYSTACK", "OTHER"]),
  amountTendered: z.number().min(0).optional(),
  notes: z.string().optional(),
});

// ---- POST /sales/checkout ----
router.post("/checkout", requirePermission("sales.create"), async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { items, paymentMethod, amountTendered, notes, customerId } = parsed.data;

  if (paymentMethod === "PAYSTACK") {
    return res.status(400).json({
      error:
        "Paystack checkout isn't available yet — it requires backend payment verification, coming in Phase 5. Use CASH, MOBILE_MONEY, BANK_TRANSFER, or OTHER for now.",
    });
  }

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (customerId) {
        const customer = await tx.customer.findFirst({
          where: { id: customerId, businessId: req.auth!.businessId },
        });
        if (!customer) throw new Error("CUSTOMER_NOT_FOUND");
      }

      // Fetch, validate, and price every line the same way every checkout path does.
      const { lineData, subtotal, discountTotal, total } = await priceSaleItems(
        tx,
        req.auth!.businessId,
        items
      );

      if (paymentMethod === "CASH" && amountTendered !== undefined && amountTendered < Number(total)) {
        throw new Error("INSUFFICIENT_TENDER");
      }

      const receiptNumber = await nextReceiptNumber(tx, req.auth!.businessId);

      const sale = await tx.sale.create({
        data: {
          businessId: req.auth!.businessId,
          cashierId: req.auth!.userId,
          customerId: customerId ?? null,
          receiptNumber,
          subtotal,
          discountTotal,
          total,
          paymentMethod,
          paymentStatus: "SUCCESSFUL",
          amountTendered: amountTendered ?? null,
          changeGiven:
            paymentMethod === "CASH" && amountTendered !== undefined
              ? new Prisma.Decimal(amountTendered).sub(total)
              : null,
          notes,
          items: {
            create: lineData.map((l) => ({
              productId: l.product.id,
              productName: l.product.name,
              unitPrice: l.unitPrice,
              unitCost: l.product.costPrice,
              quantity: l.item.quantity,
              discount: l.item.discount,
              lineTotal: l.lineTotal,
            })),
          },
        },
        include: { items: true },
      });

      // Reduce stock for each line, one movement per product, referencing this sale.
      for (const l of lineData) {
        await applyProductStock({
          tx,
          businessId: req.auth!.businessId,
          productId: l.product.id,
          type: "SALE",
          quantityChange: -l.item.quantity,
          reason: `Sale ${receiptNumber}`,
          reference: sale.id,
          userId: req.auth!.userId,
        });
      }

      // Post the double-entry accounting impact — same transaction, so a
      // failure here rolls back the sale and stock change too.
      await postSaleJournalEntry({
        tx,
        businessId: req.auth!.businessId,
        saleId: sale.id,
        receiptNumber,
        paymentMethod,
        total,
        lineData,
        createdById: req.auth!.userId,
      });

      return sale;
    });

    await recordAudit({
      businessId: req.auth!.businessId,
      userId: req.auth!.userId,
      action: "SALE_COMPLETED",
      entity: "Sale",
      entityId: result.id,
      metadata: { receiptNumber: result.receiptNumber, total: result.total },
    });

    return res.status(201).json({ sale: result });
  } catch (err: any) {
    const mapped = mapPricingError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.error });
    throw err;
  }
});

// ---- GET /sales ----
// Query params: from, to (ISO dates), cashierId, status (COMPLETED|CANCELLED),
// paymentMethod, q (receipt number contains)
router.get("/", requirePermission("sales.view"), async (req, res) => {
  const { from, to, cashierId, status, paymentMethod, q } = req.query;
  const where: any = { businessId: req.auth!.businessId };
  if (cashierId) where.cashierId = String(cashierId);
  if (status === "COMPLETED" || status === "CANCELLED") where.status = status;
  if (typeof paymentMethod === "string" && ["CASH", "MOBILE_MONEY", "BANK_TRANSFER", "PAYSTACK", "OTHER"].includes(paymentMethod)) {
    where.paymentMethod = paymentMethod;
  }
  if (typeof q === "string" && q.trim()) where.receiptNumber = { contains: q.trim(), mode: "insensitive" };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(String(from));
    if (to) where.createdAt.lte = new Date(String(to));
  }

  const sales = await prisma.sale.findMany({
    where,
    include: { cashier: { select: { id: true, name: true } }, _count: { select: { items: true } }, order: { select: { table: { select: { name: true } } } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  return res.json({ sales });
});

// ---- GET /sales/:id ----
router.get("/:id", requirePermission("sales.view"), async (req, res) => {
  const sale = await prisma.sale.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
    include: { items: true, cashier: { select: { id: true, name: true } } },
  });
  if (!sale) return res.status(404).json({ error: "Sale not found" });
  return res.json({ sale });
});

// ---- GET /sales/:id/receipt ----
// Returns structured receipt content (rule #24). Printing/PDF/share formatting is a client concern.
router.get("/:id/receipt", requirePermission("sales.view"), async (req, res) => {
  const sale = await prisma.sale.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
    include: { items: true, cashier: { select: { id: true, name: true } }, business: true },
  });
  if (!sale) return res.status(404).json({ error: "Sale not found" });

  return res.json({
    receipt: {
      business: {
        name: sale.business.name,
        address: sale.business.address,
        phone: sale.business.phone,
        logoUrl: sale.business.logoUrl,
      },
      receiptNumber: sale.receiptNumber,
      dateTime: sale.createdAt,
      cashier: sale.cashier.name,
      items: sale.items.map((i) => ({
        name: i.productName,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        discount: i.discount,
        lineTotal: i.lineTotal,
      })),
      subtotal: sale.subtotal,
      discountTotal: sale.discountTotal,
      total: sale.total,
      paymentMethod: sale.paymentMethod,
      paymentStatus: sale.paymentStatus,
      amountTendered: sale.amountTendered,
      changeGiven: sale.changeGiven,
      status: sale.status,
    },
  });
});

// ---- POST /sales/:id/cancel ----
// Never deletes the sale (rule #22) — flips status and creates
// compensating RETURN movements to restore stock.
const cancelSchema = z.object({ reason: z.string().min(1) });

router.post("/:id/cancel", requirePermission("sales.cancel"), async (req, res) => {
  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const sale = await prisma.sale.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
    include: { items: true, paystackTransaction: true },
  });
  if (!sale) return res.status(404).json({ error: "Sale not found" });
  if (sale.status === "CANCELLED") {
    return res.status(409).json({ error: "Sale is already cancelled" });
  }

  // For a Paystack sale, actually move the money back BEFORE touching
  // stock/status — never mark something "refunded" that we didn't confirm
  // with the provider. If the refund call fails, the cancellation aborts.
  if (sale.paymentMethod === "PAYSTACK") {
    if (!sale.paystackTransaction) {
      return res.status(409).json({
        error: "This Paystack sale has no linked transaction on record — cannot process an automatic refund. Contact support.",
      });
    }
    try {
      const secretKey = await getBusinessPaystackSecretKey(req.auth!.businessId);
      await createRefund({ transactionReference: sale.paystackTransaction.reference }, secretKey);
    } catch (err: any) {
      if (err instanceof PaystackNotConfiguredError) {
        return res.status(409).json({
          error: "This business no longer has Paystack configured — cannot process an automatic refund. Contact support.",
        });
      }
      return res.status(502).json({ error: `Paystack refund failed: ${err.message}. Sale was NOT cancelled.` });
    }
  }

  const finalPaymentStatus = sale.paymentMethod === "PAYSTACK" ? "REFUNDED" : "REVERSED";
  const costTotal = sale.items.reduce((sum, item) => sum + Number(item.unitCost) * item.quantity, 0);

  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const item of sale.items) {
      await applyProductStock({
        tx,
        businessId: req.auth!.businessId,
        productId: item.productId,
        type: "RETURN",
        quantityChange: item.quantity, // restore stock
        reason: `Cancellation of sale ${sale.receiptNumber}: ${parsed.data.reason}`,
        reference: sale.id,
        userId: req.auth!.userId,
        allowNegativeStock: true, // restoring stock always moves quantity up, never below 0
      });
    }

    await postSaleReversalJournalEntry({
      tx,
      businessId: req.auth!.businessId,
      saleId: sale.id,
      receiptNumber: sale.receiptNumber,
      paymentMethod: sale.paymentMethod,
      total: sale.total,
      costTotal,
      createdById: req.auth!.userId,
      reason: parsed.data.reason,
    });

    return tx.sale.update({
      where: { id: sale.id },
      data: { status: "CANCELLED", paymentStatus: finalPaymentStatus },
    });
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "SALE_CANCELLED",
    entity: "Sale",
    entityId: sale.id,
    metadata: { reason: parsed.data.reason },
  });

  return res.json({ sale: updated });
});

export default router;
