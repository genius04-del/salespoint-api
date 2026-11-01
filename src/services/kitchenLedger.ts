import { Prisma } from "@prisma/client";
import { createJournalEntry, ACCOUNT_CODES } from "./journal";

type Db = Prisma.TransactionClient;

// Loss on stock that goes missing, is spoiled or wasted. Created on first use
// (like Cash Over/Short) so existing businesses need no data migration.
export const INVENTORY_SHRINKAGE_CODE = "5920";

export async function ensureShrinkageAccount(db: Db, businessId: string) {
  const existing = await db.account.findFirst({ where: { businessId, code: INVENTORY_SHRINKAGE_CODE } });
  if (existing) return;
  await db.account.create({
    data: {
      businessId,
      code: INVENTORY_SHRINKAGE_CODE,
      name: "Inventory Shrinkage",
      type: "EXPENSE",
      normalBalance: "DEBIT",
      isSystem: true,
    },
  });
}

// net < 0 is a LOSS: Dr Shrinkage, Cr Inventory.  net > 0 is a gain: reverse.
// Returns null when there is nothing to post.
export async function postShrinkageEntry(params: {
  tx: Db;
  businessId: string;
  net: Prisma.Decimal.Value; // signed value of the stock change
  description: string;
  sourceType: string;
  sourceId: string;
  createdById?: string | null;
}) {
  const net = new Prisma.Decimal(params.net);
  if (net.isZero()) return null;
  await ensureShrinkageAccount(params.tx, params.businessId);
  const amount = net.abs().toNumber();
  const lines =
    net.isNegative()
      ? [
          { accountCode: INVENTORY_SHRINKAGE_CODE, debit: amount },
          { accountCode: ACCOUNT_CODES.INVENTORY, credit: amount },
        ]
      : [
          { accountCode: ACCOUNT_CODES.INVENTORY, debit: amount },
          { accountCode: INVENTORY_SHRINKAGE_CODE, credit: amount },
        ];
  return createJournalEntry({
    tx: params.tx,
    businessId: params.businessId,
    description: params.description,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    createdById: params.createdById,
    lines,
  });
}

// Buying ingredients: Dr Inventory, Cr whatever paid for it (or Payables).
export const RECEIVE_PAID_WITH = {
  CASH: ACCOUNT_CODES.CASH,
  BANK_TRANSFER: ACCOUNT_CODES.BANK,
  MOBILE_MONEY: ACCOUNT_CODES.MOBILE_MONEY,
  ON_CREDIT: ACCOUNT_CODES.ACCOUNTS_PAYABLE,
} as const;
export type ReceivePaidWith = keyof typeof RECEIVE_PAID_WITH;

export async function postIngredientPurchaseEntry(params: {
  tx: Db;
  businessId: string;
  amount: Prisma.Decimal.Value;
  paidWith: ReceivePaidWith;
  description: string;
  sourceId: string;
  createdById?: string | null;
}) {
  const amount = new Prisma.Decimal(params.amount).toNumber();
  if (amount <= 0) return null;
  return createJournalEntry({
    tx: params.tx,
    businessId: params.businessId,
    description: params.description,
    sourceType: "INGREDIENT_PURCHASE",
    sourceId: params.sourceId,
    createdById: params.createdById,
    lines: [
      { accountCode: ACCOUNT_CODES.INVENTORY, debit: amount },
      { accountCode: RECEIVE_PAID_WITH[params.paidWith], credit: amount },
    ],
  });
}
