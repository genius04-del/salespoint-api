import { Prisma } from "@prisma/client";

export interface JournalLineInput {
  accountCode: string;
  debit?: number | Prisma.Decimal;
  credit?: number | Prisma.Decimal;
  description?: string;
}

interface CreateJournalEntryParams {
  tx: Prisma.TransactionClient;
  businessId: string;
  description: string;
  sourceType: string;
  sourceId?: string;
  createdById?: string | null;
  entryDate?: Date;
  lines: JournalLineInput[];
}

// The ONLY function allowed to write a JournalEntry. Enforces rule #17
// (total debits === total credits) before anything is written — an
// unbalanced entry is a thrown error, not a silently-accepted row.
export async function createJournalEntry(params: CreateJournalEntryParams) {
  const { tx, businessId, description, sourceType, sourceId, createdById, entryDate, lines } = params;

  if (lines.length < 2) {
    throw new Error("JOURNAL_ENTRY_NEEDS_AT_LEAST_TWO_LINES");
  }

  // Resolve every account code to an ID up front, scoped to this business,
  // so a typo'd code fails loudly instead of silently posting to the wrong account.
  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const accounts = await tx.account.findMany({
    where: { businessId, code: { in: codes } },
  });
  const accountByCode = new Map(accounts.map((a) => [a.code, a]));

  for (const code of codes) {
    if (!accountByCode.has(code)) {
      throw new Error(`ACCOUNT_NOT_FOUND:${code}`);
    }
  }

  let totalDebit = new Prisma.Decimal(0);
  let totalCredit = new Prisma.Decimal(0);
  const resolvedLines = lines.map((l) => {
    const debit = new Prisma.Decimal(l.debit ?? 0);
    const credit = new Prisma.Decimal(l.credit ?? 0);
    totalDebit = totalDebit.add(debit);
    totalCredit = totalCredit.add(credit);
    return {
      accountId: accountByCode.get(l.accountCode)!.id,
      debit,
      credit,
      description: l.description,
    };
  });

  if (!totalDebit.equals(totalCredit)) {
    throw new Error(
      `UNBALANCED_JOURNAL_ENTRY: debits=${totalDebit.toString()} credits=${totalCredit.toString()}`
    );
  }

  return tx.journalEntry.create({
    data: {
      businessId,
      description,
      sourceType,
      sourceId,
      createdById,
      entryDate: entryDate ?? new Date(),
      lines: { create: resolvedLines },
    },
    include: { lines: true },
  });
}

// Maps a PaymentMethod to the Chart of Accounts code representing where
// that money lands/leaves from. Kept in one place so every module (sales,
// purchases, expenses) treats payment methods identically.
export function accountCodeForPaymentMethod(method: string): string {
  switch (method) {
    case "CASH":
      return "1000";
    case "BANK_TRANSFER":
      return "1010";
    case "MOBILE_MONEY":
      return "1020";
    case "PAYSTACK":
      return "1030";
    default:
      return "1000"; // OTHER falls back to Cash
  }
}

export const ACCOUNT_CODES = {
  CASH: "1000",
  BANK: "1010",
  MOBILE_MONEY: "1020",
  PAYSTACK_CLEARING: "1030",
  INVENTORY: "1040",
  ACCOUNTS_RECEIVABLE: "1050",
  ACCOUNTS_PAYABLE: "2000",
  OTHER_PAYABLES: "2010",
  OWNER_CAPITAL: "3000",
  RETAINED_EARNINGS: "3010",
  SALES_REVENUE: "4000",
  OTHER_INCOME: "4010",
  COST_OF_GOODS_SOLD: "5000",
  RENT: "5100",
  UTILITIES: "5110",
  TRANSPORT: "5120",
  SALARIES: "5130",
  ADVERTISING: "5140",
  INTERNET: "5150",
  REPAIRS: "5160",
  OTHER_EXPENSES: "5900",
} as const;
