import { Prisma } from "@prisma/client";
import { accountCodeForPaymentMethod, createJournalEntry } from "./journal";

// ---------------------------------------------------------------------------
// Pure helpers (no database) — unit-tested in __tests__/dayClose.test.ts
// ---------------------------------------------------------------------------

// Methods the manager physically counts / checks at close. PAYSTACK is
// deliberately absent: that money never touches the drawer and is verified
// server-side with Paystack, so it is reported but never "counted".
export const COUNTED_METHODS = ["CASH", "MOBILE_MONEY", "BANK_TRANSFER", "OTHER"] as const;
export type CountedMethod = (typeof COUNTED_METHODS)[number];
export const ALL_METHODS = [...COUNTED_METHODS, "PAYSTACK"] as const;
export type AnyMethod = (typeof ALL_METHODS)[number];

export type MethodTotals = Record<AnyMethod, number>;

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function emptyTotals(): MethodTotals {
  return { CASH: 0, MOBILE_MONEY: 0, BANK_TRANSFER: 0, OTHER: 0, PAYSTACK: 0 };
}

export function addTotal(totals: MethodTotals, method: string, amount: number) {
  if (method in totals) totals[method as AnyMethod] = round2(totals[method as AnyMethod] + amount);
}

export interface ExpectedRow {
  method: CountedMethod;
  openingFloat: number; // only ever non-zero for CASH
  sales: number;
  paidOut: number; // expenses, supplier payments and refunds taken from this method
  expected: number; // openingFloat + sales - paidOut
}

// What SHOULD be in the drawer / wallet / bank for each countable method.
export function buildExpected(params: {
  openingFloat: number;
  salesByMethod: MethodTotals;
  paidOutByMethod: MethodTotals;
}): ExpectedRow[] {
  return COUNTED_METHODS.map((method) => {
    const openingFloat = method === "CASH" ? params.openingFloat : 0;
    const sales = params.salesByMethod[method];
    const paidOut = params.paidOutByMethod[method];
    return {
      method,
      openingFloat: round2(openingFloat),
      sales: round2(sales),
      paidOut: round2(paidOut),
      expected: round2(openingFloat + sales - paidOut),
    };
  });
}

export type VarianceKind = "BALANCED" | "OVER" | "SHORT";

// counted - expected. Negative = short (money missing), positive = over.
export function computeVariance(counted: number, expected: number): number {
  return round2(counted - expected);
}

export function classifyVariance(variance: number): VarianceKind {
  if (Math.abs(variance) < 0.005) return "BALANCED";
  return variance > 0 ? "OVER" : "SHORT";
}

export interface CountInput {
  method: CountedMethod;
  counted: number;
}

export interface ReconciledRow extends ExpectedRow {
  counted: number;
  variance: number;
  kind: VarianceKind;
}

// Lines the manager's counts up against the system's expectation.
// A method the manager didn't enter is treated as 0 counted ONLY when nothing
// was expected for it — otherwise it is reported in `missing` so the caller can
// refuse to close on a blank (a blank is not the same as "I counted zero").
export function reconcile(expected: ExpectedRow[], counts: CountInput[]) {
  const countedBy = new Map<string, number>();
  for (const c of counts) countedBy.set(c.method, c.counted);

  const missing: CountedMethod[] = [];
  const rows: ReconciledRow[] = expected.map((e) => {
    let counted = countedBy.get(e.method);
    if (counted === undefined) {
      if (Math.abs(e.expected) >= 0.005) missing.push(e.method);
      counted = 0;
    }
    const variance = computeVariance(counted, e.expected);
    return { ...e, counted: round2(counted), variance, kind: classifyVariance(variance) };
  });

  const totalExpected = round2(rows.reduce((s, r) => s + r.expected, 0));
  const totalCounted = round2(rows.reduce((s, r) => s + r.counted, 0));
  const totalVariance = round2(rows.reduce((s, r) => s + r.variance, 0));
  const balanced = rows.every((r) => r.kind === "BALANCED");
  return { rows, missing, totalExpected, totalCounted, totalVariance, balanced };
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

type Db = Prisma.TransactionClient;

const METHOD_FOR_ACCOUNT_CODE: Record<string, AnyMethod> = {
  "1000": "CASH",
  "1010": "BANK_TRANSFER",
  "1020": "MOBILE_MONEY",
};

export interface CashierFigures {
  cashierId: string;
  name: string;
  orders: number;
  totals: MethodTotals;
}

export interface DayFigures {
  from: Date;
  to: Date;
  orders: number;
  salesByMethod: MethodTotals;
  paidOutByMethod: MethodTotals;
  byCashier: CashierFigures[];
}

// Everything that moved money in [from, to] for one business.
// - Sales: completed + successfully paid, by payment method (and by cashier).
// - Money out of the till: expenses (by the account they were paid from),
//   supplier payments (by method), and refunds of sales made BEFORE `from`
//   but cancelled inside the window.
export async function gatherDayFigures(
  db: Db,
  businessId: string,
  from: Date,
  to: Date
): Promise<DayFigures> {
  const range = { gte: from, lte: to };

  const [sales, expenses, supplierPayments, refunded] = await Promise.all([
    db.sale.findMany({
      where: { businessId, status: "COMPLETED", paymentStatus: "SUCCESSFUL", createdAt: range },
      select: { paymentMethod: true, total: true, cashierId: true, cashier: { select: { name: true } } },
    }),
    db.expense.findMany({
      where: { businessId, createdAt: range },
      select: { amount: true, paymentAccount: { select: { code: true } } },
    }),
    db.purchasePayment.findMany({
      where: { businessId, createdAt: range },
      select: { amount: true, method: true },
    }),
    db.sale.findMany({
      where: { businessId, status: "CANCELLED", createdAt: { lt: from }, updatedAt: range },
      select: { paymentMethod: true, total: true },
    }),
  ]);

  const salesByMethod = emptyTotals();
  const paidOutByMethod = emptyTotals();
  const cashiers = new Map<string, CashierFigures>();

  for (const s of sales as any[]) {
    const amount = Number(s.total);
    addTotal(salesByMethod, s.paymentMethod, amount);
    let c = cashiers.get(s.cashierId);
    if (!c) {
      c = { cashierId: s.cashierId, name: s.cashier?.name ?? "Unknown", orders: 0, totals: emptyTotals() };
      cashiers.set(s.cashierId, c);
    }
    c.orders += 1;
    addTotal(c.totals, s.paymentMethod, amount);
  }

  for (const e of expenses as any[]) {
    const method = METHOD_FOR_ACCOUNT_CODE[e.paymentAccount?.code];
    if (method) addTotal(paidOutByMethod, method, Number(e.amount));
  }
  for (const p of supplierPayments as any[]) addTotal(paidOutByMethod, p.method, Number(p.amount));
  for (const r of refunded as any[]) {
    if (r.paymentMethod !== "PAYSTACK") addTotal(paidOutByMethod, r.paymentMethod, Number(r.total));
  }

  return {
    from,
    to,
    orders: (sales as any[]).length,
    salesByMethod,
    paidOutByMethod,
    byCashier: [...cashiers.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// "Cash Over/Short" — where counting differences land in the ledger. Created
// on first use so businesses that already have a chart of accounts don't need
// a migration. It is an EXPENSE account: a shortage is a debit (cost), an
// overage a credit (reduces cost), so it flows into Profit & Loss by itself.
export const CASH_OVER_SHORT_CODE = "5910";

async function ensureCashOverShortAccount(db: Db, businessId: string) {
  const existing = await db.account.findFirst({ where: { businessId, code: CASH_OVER_SHORT_CODE } });
  if (existing) return;
  await db.account.create({
    data: {
      businessId,
      code: CASH_OVER_SHORT_CODE,
      name: "Cash Over/Short",
      type: "EXPENSE",
      normalBalance: "DEBIT",
      isSystem: true,
    },
  });
}

// Posts one balanced journal entry per payment method that doesn't balance.
// SHORT  (counted < expected): Debit Cash Over/Short, Credit the money account.
// OVER   (counted > expected): Debit the money account, Credit Cash Over/Short.
// Returns the journal entry id per method so it can be linked to the count row.
export async function postVarianceEntries(params: {
  tx: Db;
  businessId: string;
  dayId: string;
  rows: ReconciledRow[];
  createdById: string;
  closedAt: Date;
}): Promise<Partial<Record<CountedMethod, string>>> {
  const { tx, businessId, dayId, rows, createdById, closedAt } = params;
  const posted: Partial<Record<CountedMethod, string>> = {};

  const unbalanced = rows.filter((r) => r.kind !== "BALANCED");
  if (unbalanced.length === 0) return posted;

  await ensureCashOverShortAccount(tx, businessId);

  for (const r of unbalanced) {
    const amount = Math.abs(r.variance);
    const moneyAccount = accountCodeForPaymentMethod(r.method);
    const short = r.kind === "SHORT";
    const entry = await createJournalEntry({
      tx,
      businessId,
      description: `Day close ${short ? "shortage" : "overage"} — ${r.method.replace(/_/g, " ").toLowerCase()}`,
      sourceType: "DAY_CLOSE",
      sourceId: dayId,
      createdById,
      entryDate: closedAt,
      lines: short
        ? [
            { accountCode: CASH_OVER_SHORT_CODE, debit: amount },
            { accountCode: moneyAccount, credit: amount },
          ]
        : [
            { accountCode: moneyAccount, debit: amount },
            { accountCode: CASH_OVER_SHORT_CODE, credit: amount },
          ],
    });
    posted[r.method] = entry.id;
  }
  return posted;
}
