import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = vi.hoisted(() => ({ product: [] as any[], ingredient: [] as any[] }));

vi.mock("../inventory", () => ({ applyInventoryMovement: async (p: any) => void calls.product.push(p) }));
vi.mock("../ingredientStock", () => ({ applyIngredientMovement: async (p: any) => void calls.ingredient.push(p) }));
vi.mock("@prisma/client", async () => {
  const { Decimal } = await import("@prisma/client/runtime/library");
  return { Prisma: { Decimal } };
});

import { applyProductStock, productsWithRecipes } from "../productStock";

const txWith = (lines: any[]) => ({ recipeLine: { findMany: async () => lines } });

beforeEach(() => {
  calls.product = [];
  calls.ingredient = [];
});

const base = { businessId: "b1", productId: "pizza", reason: "Sale RCT-1", reference: "s1", userId: "u1" };

describe("applyProductStock", () => {
  it("falls back to normal product stock when there is no recipe", async () => {
    await applyProductStock({ ...base, tx: txWith([]), type: "SALE", quantityChange: -3 } as any);
    expect(calls.product).toHaveLength(1);
    expect(calls.product[0].quantityChange).toBe(-3);
    expect(calls.ingredient).toHaveLength(0);
  });

  it("consumes recipe ingredients per unit sold", async () => {
    const tx = txWith([
      { ingredientId: "dough", quantity: "1" },
      { ingredientId: "cheese", quantity: "0.05" },
    ]);
    await applyProductStock({ ...base, tx, type: "SALE", quantityChange: -4 } as any);
    expect(calls.product).toHaveLength(0);
    const byId = Object.fromEntries(calls.ingredient.map((c) => [c.ingredientId, c]));
    expect(byId.dough.quantityChange.toString()).toBe("-4");
    expect(byId.cheese.quantityChange.toString()).toBe("-0.2");
    expect(byId.dough.type).toBe("SALE_USAGE");
  });

  it("never blocks a sale on low ingredients", async () => {
    await applyProductStock({ ...base, tx: txWith([{ ingredientId: "dough", quantity: "1" }]), type: "SALE", quantityChange: -1 } as any);
    expect(calls.ingredient[0].allowNegative).toBe(true);
  });

  it("gives ingredients back on a return", async () => {
    await applyProductStock({ ...base, tx: txWith([{ ingredientId: "cheese", quantity: "0.05" }]), type: "RETURN", quantityChange: 2 } as any);
    expect(calls.ingredient[0].type).toBe("SALE_RETURN");
    expect(calls.ingredient[0].quantityChange.toString()).toBe("0.1");
  });
});

describe("productsWithRecipes", () => {
  it("returns only the ids that have a recipe", async () => {
    const tx = { recipeLine: { findMany: async () => [{ productId: "pizza" }, { productId: "pizza" }] } };
    const set = await productsWithRecipes(tx as any, ["pizza", "cola"]);
    expect([...set]).toEqual(["pizza"]);
  });
  it("skips the query for an empty list", async () => {
    expect((await productsWithRecipes({} as any, [])).size).toBe(0);
  });
});

import { portionsFromRecipe, withRecipePortions } from "../productStock";

describe("portionsFromRecipe", () => {
  const line = (quantity: string, onHand: string) => ({ quantity, ingredient: { currentQuantity: onHand } });
  it("is decided by the scarcest ingredient, rounded down", () => {
    // dough 10/1 = 10, cheese 0.4/0.05 = 8, pepperoni 1/0.03 = 33
    expect(portionsFromRecipe([line("1", "10"), line("0.05", "0.4"), line("0.03", "1")])).toBe(8);
  });
  it("treats an ingredient at or below zero as none", () => {
    expect(portionsFromRecipe([line("1", "10"), line("0.05", "-2")])).toBe(0);
  });
  it("is zero for an empty recipe", () => expect(portionsFromRecipe([])).toBe(0));
});

describe("withRecipePortions", () => {
  it("replaces quantity for dishes with a recipe and leaves other products alone", async () => {
    const db = {
      recipeLine: {
        findMany: async () => [{ productId: "pizza", quantity: "0.5", ingredient: { currentQuantity: "3" } }],
      },
    };
    const out = await withRecipePortions(db as any, [
      { id: "pizza", currentQuantity: 0 },
      { id: "cola", currentQuantity: 12 },
    ]);
    expect(out).toEqual([
      { id: "pizza", currentQuantity: 6, hasRecipe: true },
      { id: "cola", currentQuantity: 12, hasRecipe: false },
    ]);
  });
});
