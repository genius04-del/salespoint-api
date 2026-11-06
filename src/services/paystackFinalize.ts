import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { verifyTransaction } from "./paystack";
import { getBusinessPaystackSecretKey } from "./businessPaystackKeys";
import { priceSaleItems, nextReceiptNumber } from "./salePricing";
import { applyProductStock } from "./productStock";
import { getDeductionState } from "./stockDeduction";
import { recordAudit } from "../utils/audit";
import { postSaleJournalEntry } from "./saleJournal";

interface FinalizeResult {
  status: "already_processed" | "success" | "failed" | "not_found";
  saleId?: string;
  reconciliationNeeded?: boolean;
}

// The ONLY place a PaystackTransaction is allowed to turn into a Sale.
// Always independently re-verifies with Paystack (never trusts the caller's
// claim of success) and uses a compare-and-swap update so two concurrent
// callers (a real webhook + a status-poll self-heal, or two webhook
// deliveries) can never both create a sale for the same reference.
export async function finalizePaystackTransaction(reference: string): Promise<FinalizeResult> {
  const existing = await prisma.paystackTransaction.findUnique({ where: { reference } });
  if (!existing) return { status: "not_found" };

  if (existing.status === "SUCCESSFUL") {
    return { status: "already_processed", saleId: existing.saleId ?? undefined };
  }
  if (existing.status === "FAILED" || existing.status === "ABANDONED") {
    return { status: "already_processed" };
  }

  // Independent server-to-server check — the actual source of truth.
  // existing.businessId is already known from our own transaction record,
  // so this never has to guess whose Paystack account a reference belongs to.
  const secretKey = await getBusinessPaystackSecretKey(existing.businessId);
  const verified = await verifyTransaction(reference, secretKey);

  if (verified.status !== "success") {
    // Compare-and-swap: only flip PENDING -> FAILED, so a late/duplicate
    // "failed" check can't stomp on a result another call already finalized.
    await prisma.paystackTransaction.updateMany({
      where: { id: existing.id, status: "PENDING" },
      data: { status: verified.status === "abandoned" ? "ABANDONED" : "FAILED" },
    });
    await recordAudit({
      businessId: existing.businessId,
      userId: existing.initiatedById,
      action: "PAYMENT_FAILED",
      entity: "PaystackTransaction",
      entityId: existing.id,
      metadata: { reference, providerStatus: verified.status },
    });
    return { status: "failed" };
  }

  const expectedAmount = Math.round(Number(existing.amount) * 100);
  if (verified.amount !== expectedAmount) {
    // Amount mismatch is a red flag — never finalize, always needs human review.
    await recordAudit({
      businessId: existing.businessId,
      userId: existing.initiatedById,
      action: "PAYMENT_AMOUNT_MISMATCH",
      entity: "PaystackTransaction",
      entityId: existing.id,
      metadata: { reference, expected: expectedAmount, received: verified.amount },
    });
    return { status: "failed", reconciliationNeeded: true };
  }

  const payload = existing.payload as {
    items: { productId: string; quantity: number; discount: number }[];
    customerId?: string;
    notes?: string;
  };

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Compare-and-swap the transaction status first — if this affects 0 rows,
    // someone else (a concurrent webhook delivery) already finalized it.
    const swap = await tx.paystackTransaction.updateMany({
      where: { id: existing.id, status: "PENDING" },
      data: { status: "SUCCESSFUL" },
    });
    if (swap.count === 0) {
      const current = await tx.paystackTransaction.findUnique({ where: { id: existing.id } });
      return { alreadyProcessed: true, saleId: current?.saleId ?? undefined };
    }

    // Stock may have moved since initialize — re-price now, but don't block
    // a payment that's already been collected; flag oversells instead.
    const { lineData, subtotal, discountTotal, total, oversold } = await priceSaleItems(
      tx,
      existing.businessId,
      payload.items,
      { allowOversell: true }
    );

    const receiptNumber = await nextReceiptNumber(tx, existing.businessId);

    const sale = await tx.sale.create({
      data: {
        businessId: existing.businessId,
        cashierId: existing.initiatedById,
        customerId: payload.customerId ?? null,
        receiptNumber,
        subtotal,
        discountTotal,
        total,
        paymentMethod: "PAYSTACK",
        paymentStatus: oversold ? "UNRECONCILED" : "SUCCESSFUL",
        notes: payload.notes,
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

    const deduction = await getDeductionState(tx, existing.businessId);
    for (const l of deduction.dayEnd ? [] : lineData) {
      await applyProductStock({
        tx,
        businessId: existing.businessId,
        productId: l.product.id,
        type: "SALE",
        quantityChange: -l.item.quantity,
        reason: `Paystack sale ${receiptNumber}`,
        reference: sale.id,
        userId: existing.initiatedById,
        allowNegativeStock: true, // payment already collected — never block on stock here
      });
    }

    await postSaleJournalEntry({
      tx,
      businessId: existing.businessId,
      saleId: sale.id,
      receiptNumber,
      paymentMethod: "PAYSTACK",
      total,
      lineData,
      createdById: existing.initiatedById,
    });

    await tx.paystackTransaction.update({
      where: { id: existing.id },
      data: { saleId: sale.id },
    });

    return { alreadyProcessed: false, saleId: sale.id, oversold };
  });

  if (result.alreadyProcessed) {
    return { status: "already_processed", saleId: result.saleId };
  }

  await recordAudit({
    businessId: existing.businessId,
    userId: existing.initiatedById,
    action: result.oversold ? "PAYMENT_VERIFIED_STOCK_SHORTFALL" : "PAYMENT_VERIFIED",
    entity: "Sale",
    entityId: result.saleId,
    metadata: { reference },
  });

  return { status: "success", saleId: result.saleId, reconciliationNeeded: result.oversold };
}
