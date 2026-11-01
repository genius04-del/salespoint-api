import { describe, it, expect } from "vitest";
import { summarizeProfit, balanceOf, round2, AccountMovement } from "../financials";
import { ACCOUNT_CODES } from "../journal";

function movement(over: Partial<AccountMovement>): AccountMovement {
  return { code: "0000", name: "Test", type: "ASSET", normalBalance: "DEBIT", debit: 0, credit: 0, net: 0, ...over };
}

describe("round2", () => {
  it("rounds to 2 decimal places", () => {
    expect(round2(1.005)).toBeCloseTo(1.01, 2); // half-up on the classic float edge case
    expect(round2(8.1 + 4.9)).toBe(13);
  });
});

describe("balanceOf", () => {
  it("returns the net for a matching account code", () => {
    const movements = [movement({ code: "1000", net: 42 })];
    expect(balanceOf(movements, "1000")).toBe(42);
  });

  it("returns 0 for a code with no movement (never null/undefined)", () => {
    expect(balanceOf([], "9999")).toBe(0);
  });
});

describe("summarizeProfit", () => {
  it("matches the spec's own worked example (rule #17): GH₵100 sale, GH₵60 cost", () => {
    // Debit Cash 100 / Credit Sales Revenue 100
    // Debit COGS 60 / Credit Inventory 60
    const movements: AccountMovement[] = [
      movement({ code: ACCOUNT_CODES.SALES_REVENUE, type: "REVENUE", normalBalance: "CREDIT", credit: 100, net: 100 }),
      movement({ code: ACCOUNT_CODES.COST_OF_GOODS_SOLD, type: "EXPENSE", normalBalance: "DEBIT", debit: 60, net: 60 }),
    ];
    const p = summarizeProfit(movements);
    expect(p.revenue).toBe(100);
    expect(p.costOfGoodsSold).toBe(60);
    expect(p.grossProfit).toBe(40); // exactly the spec's worked example
    expect(p.operatingExpenses).toBe(0);
    expect(p.netProfit).toBe(40);
  });

  it("subtracts operating expenses (but never counts COGS as an operating expense)", () => {
    const movements: AccountMovement[] = [
      movement({ code: ACCOUNT_CODES.SALES_REVENUE, type: "REVENUE", net: 100 }),
      movement({ code: ACCOUNT_CODES.COST_OF_GOODS_SOLD, type: "EXPENSE", net: 60 }),
      movement({ code: ACCOUNT_CODES.RENT, type: "EXPENSE", net: 15 }),
    ];
    const p = summarizeProfit(movements);
    expect(p.operatingExpenses).toBe(15); // rent only — COGS excluded
    expect(p.netProfit).toBe(25); // 100 - 60 - 15
  });

  it("a fully reversed sale (cancellation) nets to zero profit impact", () => {
    // Original: Credit Revenue 100, Debit COGS 60.
    // Reversal: Debit Revenue 100, Credit COGS 60. Net movement is 0 on both.
    const movements: AccountMovement[] = [
      movement({ code: ACCOUNT_CODES.SALES_REVENUE, type: "REVENUE", net: 0 }),
      movement({ code: ACCOUNT_CODES.COST_OF_GOODS_SOLD, type: "EXPENSE", net: 0 }),
    ];
    const p = summarizeProfit(movements);
    expect(p.revenue).toBe(0);
    expect(p.costOfGoodsSold).toBe(0);
    expect(p.grossProfit).toBe(0);
    expect(p.netProfit).toBe(0);
  });

  it("zero-net accounts are excluded from the line-item lists (nothing to show)", () => {
    const movements: AccountMovement[] = [
      movement({ code: ACCOUNT_CODES.SALES_REVENUE, type: "REVENUE", net: 0 }),
      movement({ code: ACCOUNT_CODES.RENT, type: "EXPENSE", net: 0 }),
    ];
    const p = summarizeProfit(movements);
    expect(p.revenueLines).toHaveLength(0);
    expect(p.expenseLines).toHaveLength(0);
  });
});
