import { describe, it, expect } from "vitest";
import { buildSalesMix } from "../salesMix";

const row = (over: Partial<Parameters<typeof buildSalesMix>[0][number]>) => ({
  productId: "p1",
  productName: "Coke",
  categoryName: "Drinks",
  quantity: 1,
  lineTotal: 5,
  unitCost: 3,
  ...over,
});

describe("buildSalesMix", () => {
  it("adds up units, revenue, cost and profit for the same product across sales", () => {
    const mix = buildSalesMix([row({ quantity: 2, lineTotal: 10 }), row({ quantity: 3, lineTotal: 15 })]);
    expect(mix.products).toHaveLength(1);
    expect(mix.products[0].quantity).toBe(5);
    expect(mix.products[0].revenue).toBe(25);
    expect(mix.products[0].cost).toBe(15); // 5 units x 3
    expect(mix.products[0].profit).toBe(10);
  });

  it("ranks by units sold, highest first", () => {
    const mix = buildSalesMix([
      row({ productId: "w", productName: "Water", quantity: 12, lineTotal: 24 }),
      row({ productId: "c", productName: "Coke", quantity: 30, lineTotal: 150 }),
      row({ productId: "f", productName: "Fanta", quantity: 5, lineTotal: 25 }),
    ]);
    expect(mix.products.map((p) => p.productName)).toEqual(["Coke", "Water", "Fanta"]);
  });

  it("computes each product's share of units and revenue", () => {
    const mix = buildSalesMix([
      row({ productId: "a", productName: "A", quantity: 1, lineTotal: 25 }),
      row({ productId: "b", productName: "B", quantity: 3, lineTotal: 75 }),
    ]);
    const a = mix.products.find((p) => p.productName === "A")!;
    expect(a.quantitySharePct).toBe(25);
    expect(a.revenueSharePct).toBe(25);
  });

  it("rolls products up into categories, with an 'Uncategorised' bucket", () => {
    const mix = buildSalesMix([
      row({ productId: "a", categoryName: "Drinks", quantity: 2, lineTotal: 20 }),
      row({ productId: "b", categoryName: "Drinks", quantity: 1, lineTotal: 10 }),
      row({ productId: "c", categoryName: null, quantity: 1, lineTotal: 30 }),
    ]);
    const drinks = mix.categories.find((c) => c.category === "Drinks")!;
    expect(drinks.quantity).toBe(3);
    expect(drinks.revenue).toBe(30);
    expect(mix.categories.find((c) => c.category === "Uncategorised")!.revenue).toBe(30);
  });

  it("handles no sales without dividing by zero", () => {
    const mix = buildSalesMix([]);
    expect(mix.products).toEqual([]);
    expect(mix.totals.itemsSold).toBe(0);
    expect(mix.totals.revenue).toBe(0);
  });

  it("keeps the product name from the sale (snapshot), grouped by product id", () => {
    const mix = buildSalesMix([row({ productName: "Coke" }), row({ productName: "Coca-Cola" })]);
    expect(mix.products).toHaveLength(1); // same productId = one line
  });
});
