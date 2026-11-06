import { describe, it, expect, vi } from "vitest";
vi.mock("@prisma/client", async () => {
  const { Decimal } = await import("@prisma/client/runtime/library");
  return { Prisma: { Decimal } };
});

import { Prisma } from "@prisma/client";
import { priceSaleItems } from "../salePricing";

function fakeTx(dayEnd: boolean) {
  return {
    product: { findMany: async () => [{ id: "cola", name: "Cola", isActive: true, currentQuantity: 0, sellingPrice: new Prisma.Decimal(10), costPrice: new Prisma.Decimal(4) }] },
    recipeLine: { findMany: async () => [] },
    business: { findUnique: async () => ({ deductStockAtDayEnd: dayEnd, stockDeductionStart: null }) },
    stockDeduction: { findFirst: async () => null },
  } as any;
}

describe("selling when stock is deducted at day end", () => {
  it("sells an item whose system stock is zero, because nothing is deducted at sale time", async () => {
    const res = await priceSaleItems(fakeTx(true), "b1", [{ productId: "cola", quantity: 3, discount: 0 }]);
    expect(Number(res.total)).toBe(30);
  });
  it("still blocks the sale when stock is deducted as it happens", async () => {
    await expect(priceSaleItems(fakeTx(false), "b1", [{ productId: "cola", quantity: 3, discount: 0 }])).rejects.toThrow("INSUFFICIENT_STOCK:Cola");
  });
});
