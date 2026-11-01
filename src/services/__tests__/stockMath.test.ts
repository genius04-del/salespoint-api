import { describe, it, expect } from "vitest";
import { vi } from "vitest";

// The generated Prisma client needs a database engine; only its Decimal
// maths is used here, and that ships in the runtime library.
vi.mock("@prisma/client", async () => {
  const { Decimal } = await import("@prisma/client/runtime/library");
  return { Prisma: { Decimal } };
});

import { Prisma } from "@prisma/client";
import { scaleComponents, recipeCost, weightedAverageCost, countLineVariance, wouldCreateCycle } from "../stockMath";

describe("scaleComponents", () => {
  it("multiplies the per-unit make-up by units produced, without float drift", () => {
    const out = scaleComponents([{ ingredientId: "flour", quantity: "0.15" }, { ingredientId: "water", quantity: "0.09" }], 40);
    expect(out[0].quantity.toString()).toBe("6");
    expect(out[1].quantity.toString()).toBe("3.6");
  });
});

describe("recipeCost", () => {
  it("sums quantity x cost for one unit sold", () => {
    const costs = new Map<string, Prisma.Decimal.Value>([["dough", 2], ["cheese", 40], ["pepperoni", 80]]);
    const cost = recipeCost(
      [{ ingredientId: "dough", quantity: 1 }, { ingredientId: "cheese", quantity: 0.05 }, { ingredientId: "pepperoni", quantity: 0.03 }],
      costs
    );
    expect(cost.toNumber()).toBe(6.4); // 2 + 2 + 2.4
  });
  it("treats an ingredient with no cost as free rather than failing", () => {
    expect(recipeCost([{ ingredientId: "x", quantity: 3 }], new Map()).toNumber()).toBe(0);
  });
});

describe("weightedAverageCost", () => {
  it("blends old stock and a new delivery", () => {
    // 10 kg @ 10 + 10 kg @ 20 = 15 average
    expect(weightedAverageCost(10, 10, 10, 20).toNumber()).toBe(15);
  });
  it("ignores negative on-hand stock", () => {
    expect(weightedAverageCost(-5, 99, 10, 20).toNumber()).toBe(20);
  });
  it("uses the incoming cost when nothing is on hand", () => {
    expect(weightedAverageCost(0, 99, 4, 12).toNumber()).toBe(12);
  });
});

describe("countLineVariance", () => {
  it("is counted minus expected; negative means missing", () => {
    const r = countLineVariance(10, 8.5, 4);
    expect(r.variance.toNumber()).toBe(-1.5);
    expect(r.value.toNumber()).toBe(-6);
  });
  it("is zero when the count matches", () => {
    expect(countLineVariance(3, 3, 9.99).value.toNumber()).toBe(0);
  });
});

describe("wouldCreateCycle", () => {
  const edges = new Map([["sauce", ["tomato", "paste"]], ["paste", ["tomato"]]]);
  it("rejects a self reference", () => expect(wouldCreateCycle("a", "a", edges)).toBe(true));
  it("rejects a loop through another prepared item", () => {
    // paste is made from tomato; making tomato from sauce -> paste -> tomato would loop
    expect(wouldCreateCycle("tomato", "sauce", edges)).toBe(true);
  });
  it("allows a normal chain", () => expect(wouldCreateCycle("pizza-base", "sauce", edges)).toBe(false));
});
