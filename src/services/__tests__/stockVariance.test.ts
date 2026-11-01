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
