// Pure profit/balance math — deliberately has NO database import, so it can
// be unit-tested without a database (see src/services/__tests__/financials.test.ts).
// The db-dependent piece that fetches journal lines lives in accountMovements.ts.
import { ACCOUNT_CODES } from "./journal";

// Plain `Math.round(n * 100) / 100` misrounds values like 1.005 down to 1.00,
// because 1.005 can't be represented exactly in IEEE-754 floating point (it's
// actually stored as ~1.00499999999999989). Nudging by Number.EPSILON first
// corrects that boundary case without meaningfully affecting anything else —
// this function is used throughout the app for displaying money amounts.
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface AccountMovement {
  code: string;
  name: string;
  type: string;
  normalBalance: string;
  debit: number;
  credit: number;
  net: number; // movement on the account's normal side (positive = grew)
}

export function balanceOf(movements: AccountMovement[], code: string): number {
  return movements.find((m) => m.code === code)?.net ?? 0;
}

// Profit & loss for a period's movements:
//   revenue      = net of all REVENUE accounts
//   COGS         = net of account 5000
//   gross profit = revenue - COGS
//   expenses     = net of every other EXPENSE account
//   net profit   = gross profit - expenses
export function summarizeProfit(movements: AccountMovement[]) {
  const revenueLines = movements.filter((m) => m.type === "REVENUE" && m.net !== 0);
  const expenseLines = movements.filter(
    (m) => m.type === "EXPENSE" && m.code !== ACCOUNT_CODES.COST_OF_GOODS_SOLD && m.net !== 0
  );

  const revenue = round2(revenueLines.reduce((s, m) => s + m.net, 0));
  const costOfGoodsSold = round2(balanceOf(movements, ACCOUNT_CODES.COST_OF_GOODS_SOLD));
  const grossProfit = round2(revenue - costOfGoodsSold);
  const operatingExpenses = round2(expenseLines.reduce((s, m) => s + m.net, 0));
  const netProfit = round2(grossProfit - operatingExpenses);

  return { revenueLines, expenseLines, revenue, costOfGoodsSold, grossProfit, operatingExpenses, netProfit };
}
