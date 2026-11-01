import { describe, it, expect } from "vitest";
import {
  buildExpected,
  classifyVariance,
  computeVariance,
  emptyTotals,
  addTotal,
  reconcile,
  COUNTED_METHODS,
} from "../dayClose";

function totals(over: Partial<Record<string, number>>) {
  const t = emptyTotals();
  for (const [k, v] of Object.entries(over)) addTotal(t, k, v as number);
  return t;
}

describe("buildExpected", () => {
  it("cash expected = opening float + cash sales - cash paid out", () => {
    const rows = buildExpected({
      openingFloat: 100,
      salesByMethod: totals({ CASH: 500, MOBILE_MONEY: 200 }),
      paidOutByMethod: totals({ CASH: 80 }),
    });
    const cash = rows.find((r) => r.method === "CASH")!;
    expect(cash.expected).toBe(520); // 100 + 500 - 80
    expect(rows.find((r) => r.method === "MOBILE_MONEY")!.expected).toBe(200);
  });

  it("only cash gets the opening float", () => {
    const rows = buildExpected({
      openingFloat: 50,
      salesByMethod: emptyTotals(),
      paidOutByMethod: emptyTotals(),
    });
    expect(rows.find((r) => r.method === "BANK_TRANSFER")!.openingFloat).toBe(0);
    expect(rows.find((r) => r.method === "CASH")!.openingFloat).toBe(50);
  });

  it("never lists PAYSTACK as a countable method (it never touches the drawer)", () => {
    expect(COUNTED_METHODS).not.toContain("PAYSTACK");
    const rows = buildExpected({ openingFloat: 0, salesByMethod: totals({ PAYSTACK: 999 }), paidOutByMethod: emptyTotals() });
    expect(rows.map((r) => r.method)).not.toContain("PAYSTACK");
    expect(rows.reduce((s, r) => s + r.expected, 0)).toBe(0);
  });

  it("avoids floating point drift (0.1 + 0.2 style)", () => {
    const sales = emptyTotals();
    addTotal(sales, "CASH", 0.1);
    addTotal(sales, "CASH", 0.2);
    const rows = buildExpected({ openingFloat: 0, salesByMethod: sales, paidOutByMethod: emptyTotals() });
    expect(rows[0].expected).toBe(0.3);
  });
});

describe("variance", () => {
  it("is counted minus expected: negative = short, positive = over", () => {
    expect(computeVariance(95, 100)).toBe(-5);
    expect(computeVariance(105.5, 100)).toBe(5.5);
    expect(computeVariance(100, 100)).toBe(0);
  });

  it("classifies BALANCED / OVER / SHORT", () => {
    expect(classifyVariance(0)).toBe("BALANCED");
    expect(classifyVariance(0.004)).toBe("BALANCED"); // below half a pesewa
    expect(classifyVariance(2)).toBe("OVER");
    expect(classifyVariance(-2)).toBe("SHORT");
  });
});

describe("reconcile", () => {
  const expected = buildExpected({
    openingFloat: 100,
    salesByMethod: totals({ CASH: 400, MOBILE_MONEY: 250 }),
    paidOutByMethod: emptyTotals(),
  });

  it("balances when every count matches", () => {
    const r = reconcile(expected, [
      { method: "CASH", counted: 500 },
      { method: "MOBILE_MONEY", counted: 250 },
    ]);
    expect(r.balanced).toBe(true);
    expect(r.totalVariance).toBe(0);
    expect(r.missing).toEqual([]);
  });

  it("reports a shortage and the overall variance", () => {
    const r = reconcile(expected, [
      { method: "CASH", counted: 480 },
      { method: "MOBILE_MONEY", counted: 250 },
    ]);
    expect(r.balanced).toBe(false);
    expect(r.rows.find((x) => x.method === "CASH")!.kind).toBe("SHORT");
    expect(r.totalVariance).toBe(-20);
  });

  it("offsetting differences still count as NOT balanced per method", () => {
    const r = reconcile(expected, [
      { method: "CASH", counted: 510 }, // +10
      { method: "MOBILE_MONEY", counted: 240 }, // -10
    ]);
    expect(r.totalVariance).toBe(0); // nets out overall...
    expect(r.balanced).toBe(false); // ...but each method is checked on its own
  });

  it("a blank count where money was expected is 'missing', not silently zero", () => {
    const r = reconcile(expected, [{ method: "CASH", counted: 500 }]);
    expect(r.missing).toEqual(["MOBILE_MONEY"]);
  });

  it("a blank count where nothing was expected is fine (counts as 0)", () => {
    const r = reconcile(expected, [
      { method: "CASH", counted: 500 },
      { method: "MOBILE_MONEY", counted: 250 },
    ]);
    expect(r.missing).toEqual([]); // bank + other expected 0, left blank
    expect(r.rows.find((x) => x.method === "BANK_TRANSFER")!.counted).toBe(0);
  });

  it("an explicit 0 count where money was expected is a real, full shortage", () => {
    const r = reconcile(expected, [
      { method: "CASH", counted: 500 },
      { method: "MOBILE_MONEY", counted: 0 },
    ]);
    expect(r.missing).toEqual([]);
    expect(r.rows.find((x) => x.method === "MOBILE_MONEY")!.variance).toBe(-250);
  });
});
