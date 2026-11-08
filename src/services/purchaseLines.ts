import { Prisma } from "@prisma/client";

export interface PurchaseItemInput {
  productId?: string;
  ingredientId?: string;
  quantity: number;
  costPrice: number; // per unit
  lineTotal?: number; // ingredient lines: exact total (avoids rounding a per-unit price)
}

export interface PurchaseLine {
  kind: "product" | "ingredient";
  refId: string;
  name: string;
  unit: string | null;
  quantity: number;
  unitCost: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

// Turns the request lines into priced lines, or says what is wrong in words
// the person can act on. Pure, so it is easy to test.
export function buildPurchaseLines(
  items: PurchaseItemInput[],
  products: Map<string, { id: string; name: string }>,
  ingredients: Map<string, { id: string; name: string; unit: string; isPrepared: boolean }>
): { lines: PurchaseLine[]; total: Prisma.Decimal } | { error: string } {
  const lines: PurchaseLine[] = [];
  let total = new Prisma.Decimal(0);
  for (const item of items) {
    if (!!item.productId === !!item.ingredientId) return { error: "Each line needs either a product or an ingredient" };
    if (item.productId) {
      const p = products.get(item.productId);
      if (!p) return { error: "One or more products not found for this business" };
      if (!Number.isInteger(item.quantity)) return { error: `${p.name} must be bought in whole units` };
      const lineTotal = new Prisma.Decimal(item.costPrice).mul(item.quantity);
      total = total.add(lineTotal);
      lines.push({ kind: "product", refId: p.id, name: p.name, unit: null, quantity: item.quantity, unitCost: new Prisma.Decimal(item.costPrice), lineTotal });
    } else {
      const ing = ingredients.get(item.ingredientId!);
      if (!ing) return { error: "One or more ingredients not found for this business" };
      if (ing.isPrepared) return { error: `${ing.name} is made in the kitchen, so it can't be bought. Record it under Production.` };
      const lineTotal =
        item.lineTotal !== undefined
          ? new Prisma.Decimal(item.lineTotal).toDecimalPlaces(2)
          : new Prisma.Decimal(item.costPrice).mul(item.quantity).toDecimalPlaces(2);
      const unitCost = lineTotal.div(item.quantity);
      total = total.add(lineTotal);
      lines.push({ kind: "ingredient", refId: ing.id, name: ing.name, unit: ing.unit, quantity: item.quantity, unitCost, lineTotal });
    }
  }
  return { lines, total };
}
