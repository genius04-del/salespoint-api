import { describe, it, expect } from "vitest";
import { vi } from "vitest";

// The generated Prisma client needs a database engine; only its Decimal
// maths is used here, and that ships in the runtime library.
vi.mock("@prisma/client", async () => {
  const { Decimal } = await import("@prisma/client/runtime/library");
  return { Prisma: { Decimal } };
});

import { rollUpCountVariance, summariseCountVariance, rollUpProductionUsage } from "../stockVariance";

const row = (over: any) => ({
  itemType: "INGREDIENT" as const, productId: null, ingredientId: "cheese", itemName: "Cheese", unit: "kg",
  variance: -1, varianceValue: -40, countedAt: new Date(), ...over,
});

describe("rollUpCountVariance", () => {
  it("adds one item's variances across counts and sorts the biggest loss first", () => {
    const items = rollUpCountVariance([
      row({}),
      row({ variance: -0.5, varianceValue: -20 }),
      row({ ingredientId: "flour", itemName: "Flour", variance: -2, varianceValue: -10 }),
      row({ ingredientId: "oil", itemName: "Oil", variance: 1, varianceValue: 15 }),
    ]);
    expect(items.map((i) => i.name)).toEqual(["Cheese", "Flour", "Oil"]);
    expect(items[0]).toMatchObject({ timesCounted: 2, timesShort: 2, totalVariance: -1.5, totalValue: -60 });
  });

  it("ignores uncounted lines and items that net to zero", () => {
    const items = rollUpCountVariance([
      row({ variance: null, varianceValue: null }),
      row({ ingredientId: "salt", itemName: "Salt", variance: 1, varianceValue: 2 }),
      row({ ingredientId: "salt", itemName: "Salt", variance: -1, varianceValue: -2 }),
    ]);
    expect(items).toHaveLength(0);
  });

  it("keeps a product and an ingredient with the same name apart", () => {
    const items = rollUpCountVariance([
      row({ itemType: "PRODUCT", productId: "p1", ingredientId: null, itemName: "Water", unit: "unit" }),
      row({ itemName: "Water", ingredientId: "i1" }),
    ]);
    expect(items).toHaveLength(2);
  });
});

describe("summariseCountVariance", () => {
  it("splits shortage and surplus and nets them", () => {
    const s = summariseCountVariance([
      { totalValue: -60 } as any, { totalValue: -10 } as any, { totalValue: 15.5 } as any,
    ]);
    expect(s).toEqual({ loss: -70, gain: 15.5, net: -54.5 });
  });
});

describe("rollUpProductionUsage", () => {
  const line = (over: any) => ({ ingredientId: "flour", name: "Flour", unit: "kg", quantityUsed: 6.5, standardQuantity: 6, unitCost: 10, ...over });
  it("shows over-use against the standard make-up, valued at cost", () => {
    const r = rollUpProductionUsage([line({}), line({ quantityUsed: 12.2, standardQuantity: 12 })]);
    expect(r).toEqual([{ ingredientId: "flour", name: "Flour", unit: "kg", used: 18.7, standard: 18, overUse: 0.7, value: 7 }]);
  });
  it("skips lines with no standard to compare against", () => {
    expect(rollUpProductionUsage([line({ standardQuantity: 0 })])).toEqual([]);
  });
  it("drops ingredients used exactly to standard", () => {
    expect(rollUpProductionUsage([line({ quantityUsed: 6 })])).toEqual([]);
  });
});

import { buildMovementReport } from "../stockVariance";

describe("buildMovementReport", () => {
  const from = new Date("2026-11-01T00:00:00Z");
  const to = new Date("2026-11-01T23:59:59Z");
  const day = (h: number) => new Date(Date.UTC(2026, 10, 1, h));
  const water = { itemType: "PRODUCT" as const, itemId: "P:w", name: "Mineral water", unit: "unit", category: "Drinks", currentQuantity: 18, unitCost: 5 };

  it("reproduces the opening 30, sold 10, closing 18 case: 2 down", () => {
    const rows = buildMovementReport(
      [water],
      [
        { itemId: "P:w", kind: "OTHER", change: -10, previous: 30, next: 20, at: day(10) },
        { itemId: "P:w", kind: "COUNT", change: -2, previous: 20, next: 18, at: day(22) },
      ],
      new Set(["P:w"]), from, to
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ opening: 30, stockOut: 10, theoreticalClosing: 20, actualClosing: 18, variance: -2, varianceValue: -10, counted: true });
  });

  it("an item counted with no difference shows zero variance, not 'not counted'", () => {
    const rows = buildMovementReport(
      [{ ...water, currentQuantity: 20 }],
      [{ itemId: "P:w", kind: "OTHER", change: -10, previous: 30, next: 20, at: day(10) }],
      new Set(["P:w"]), from, to
    );
    expect(rows[0]).toMatchObject({ theoreticalClosing: 20, actualClosing: 20, variance: 0 });
  });

  it("an item never counted has no actual closing and no variance", () => {
    const rows = buildMovementReport(
      [{ ...water, currentQuantity: 20 }],
      [{ itemId: "P:w", kind: "OTHER", change: -10, previous: 30, next: 20, at: day(10) }],
      new Set(), from, to
    );
    expect(rows[0]).toMatchObject({ theoreticalClosing: 20, actualClosing: null, variance: null });
  });

  it("separates waste from other stock going out, and counts stock in", () => {
    const rows = buildMovementReport(
      [{ ...water, currentQuantity: 37 }],
      [
        { itemId: "P:w", kind: "OTHER", change: 24, previous: 20, next: 44, at: day(8) },
        { itemId: "P:w", kind: "WASTE", change: -3, previous: 44, next: 41, at: day(9) },
        { itemId: "P:w", kind: "OTHER", change: -4, previous: 41, next: 37, at: day(10) },
      ],
      new Set(), from, to
    );
    expect(rows[0]).toMatchObject({ opening: 20, stockIn: 24, waste: 3, stockOut: 4, theoreticalClosing: 37 });
  });

  it("ignores movements after the period and uses the quantity at period end", () => {
    const rows = buildMovementReport(
      [{ ...water, currentQuantity: 5 }],
      [
        { itemId: "P:w", kind: "OTHER", change: -10, previous: 30, next: 20, at: day(10) },
        { itemId: "P:w", kind: "OTHER", change: -15, previous: 20, next: 5, at: new Date("2026-11-03T10:00:00Z") },
      ],
      new Set(), from, to
    );
    expect(rows[0]).toMatchObject({ opening: 30, stockOut: 10, theoreticalClosing: 20 });
  });

  it("an untouched item uses what is on the shelf now as opening and closing", () => {
    const rows = buildMovementReport([{ ...water, currentQuantity: 12 }], [], new Set(), from, to);
    expect(rows[0]).toMatchObject({ opening: 12, theoreticalClosing: 12, stockIn: 0, stockOut: 0 });
  });

  it("leaves out items with nothing in them and no activity", () => {
    expect(buildMovementReport([{ ...water, currentQuantity: 0 }], [], new Set(), from, to)).toHaveLength(0);
  });
});
