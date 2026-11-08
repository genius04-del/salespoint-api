import { describe, it, expect, vi } from "vitest";

vi.mock("@prisma/client", async () => {
  const Decimal = (await import("@prisma/client/runtime/library")).Decimal;
  return { Prisma: { Decimal } };
});

import { buildPurchaseLines } from "../purchaseLines";

const products = new Map([["p1", { id: "p1", name: "Coke 50cl" }]]);
const ingredients = new Map([
  ["i1", { id: "i1", name: "Flour", unit: "kg", isPrepared: false }],
  ["i2", { id: "i2", name: "Dough ball", unit: "piece", isPrepared: true }],
]);

describe("buildPurchaseLines", () => {
  it("prices a mixed purchase and totals it", () => {
    const r = buildPurchaseLines(
      [
        { productId: "p1", quantity: 24, costPrice: 5 },
        { ingredientId: "i1", quantity: 200, costPrice: 13, lineTotal: 2600 },
      ],
      products,
      ingredients
    );
    if ("error" in r) throw new Error(r.error);
    expect(Number(r.total)).toBe(2720);
    expect(r.lines[1].kind).toBe("ingredient");
    expect(Number(r.lines[1].unitCost)).toBe(13);
  });

  it("uses the exact line total rather than a rounded unit price", () => {
    const r = buildPurchaseLines([{ ingredientId: "i1", quantity: 3, costPrice: 33.33, lineTotal: 100 }], products, ingredients);
    if ("error" in r) throw new Error(r.error);
    expect(Number(r.total)).toBe(100);
  });

  it("accepts decimal ingredient quantities but not decimal products", () => {
    expect("error" in buildPurchaseLines([{ ingredientId: "i1", quantity: 2.5, costPrice: 10 }], products, ingredients)).toBe(false);
    expect("error" in buildPurchaseLines([{ productId: "p1", quantity: 2.5, costPrice: 10 }], products, ingredients)).toBe(true);
  });

  it("rejects kitchen-made items, unknown ids and lines with both or neither id", () => {
    expect("error" in buildPurchaseLines([{ ingredientId: "i2", quantity: 1, costPrice: 1 }], products, ingredients)).toBe(true);
    expect("error" in buildPurchaseLines([{ ingredientId: "nope", quantity: 1, costPrice: 1 }], products, ingredients)).toBe(true);
    expect("error" in buildPurchaseLines([{ productId: "p1", ingredientId: "i1", quantity: 1, costPrice: 1 }], products, ingredients)).toBe(true);
    expect("error" in buildPurchaseLines([{ quantity: 1, costPrice: 1 }], products, ingredients)).toBe(true);
  });
});
