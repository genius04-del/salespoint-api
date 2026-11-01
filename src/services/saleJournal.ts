import { Prisma } from "@prisma/client";
import { createJournalEntry, accountCodeForPaymentMethod, ACCOUNT_CODES, JournalLineInput } from "./journal";

interface SaleLine {
  product: { costPrice: Prisma.Decimal | number };
  item: { quantity: number };
}

// Books a completed sale: Debit the payment account (Cash/Bank/MoMo/
// Paystack Clearing) and Credit Sales Revenue for the sale total; if the
// products carried a cost, also Debit COGS and Credit Inventory for that
// cost — recognizing gross profit automatically (rule #17's worked example).
export async function postSaleJournalEntry(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  saleId: string;
  receiptNumber: string;
  paymentMethod: string;
  total: Prisma.Decimal | number;
  lineData: SaleLine[];
  createdById?: string | null;
}) {
  const { tx, businessId, saleId, receiptNumber, paymentMethod, total, lineData, createdById } = params;

  const costTotal = lineData.reduce(
    (sum, l) => sum + Number(l.product.costPrice) * l.item.quantity,
    0
  );

  const lines: JournalLineInput[] = [
    { accountCode: accountCodeForPaymentMethod(paymentMethod), debit: Number(total) },
    { accountCode: ACCOUNT_CODES.SALES_REVENUE, credit: Number(total) },
  ];
  if (costTotal > 0) {
    lines.push(
      { accountCode: ACCOUNT_CODES.COST_OF_GOODS_SOLD, debit: costTotal },
      { accountCode: ACCOUNT_CODES.INVENTORY, credit: costTotal }
    );
  }

  return createJournalEntry({
    tx,
    businessId,
    description: `Sale ${receiptNumber}`,
    sourceType: "SALE",
    sourceId: saleId,
    createdById,
    lines,
  });
}

// Reverses a sale's financial impact on cancellation/refund (rule #22 —
// a compensating entry, never an edit/delete of the original). Restores
// inventory value and removes the recognized revenue and COGS.
export async function postSaleReversalJournalEntry(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  saleId: string;
  receiptNumber: string;
  paymentMethod: string;
  total: Prisma.Decimal | number;
  costTotal: number;
  createdById?: string | null;
  reason: string;
}) {
  const { tx, businessId, saleId, receiptNumber, paymentMethod, total, costTotal, createdById, reason } = params;

  const lines: JournalLineInput[] = [
    { accountCode: ACCOUNT_CODES.SALES_REVENUE, debit: Number(total) },
    { accountCode: accountCodeForPaymentMethod(paymentMethod), credit: Number(total) },
  ];
  if (costTotal > 0) {
    lines.push(
      { accountCode: ACCOUNT_CODES.INVENTORY, debit: costTotal },
      { accountCode: ACCOUNT_CODES.COST_OF_GOODS_SOLD, credit: costTotal }
    );
  }

  return createJournalEntry({
    tx,
    businessId,
    description: `Cancellation of sale ${receiptNumber}: ${reason}`,
    sourceType: "SALE_CANCELLATION",
    sourceId: saleId,
    createdById,
    lines,
  });
}
