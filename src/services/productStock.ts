import { Prisma, InventoryMovementType } from "@prisma/client";
import { applyInventoryMovement } from "./inventory";
import { applyIngredientMovement } from "./ingredientStock";

type MovementParams = Parameters<typeof applyInventoryMovement>[0];

// Which of these products are made from a recipe? Those are stocked by their
// ingredients, so their own currentQuantity is meaningless and must never
// block a sale.
export async function productsWithRecipes(
  tx: Prisma.TransactionClient,
  productIds: string[]
): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const rows = await tx.recipeLine.findMany({
    where: { productId: { in: productIds } },
    select: { productId: true },
  });
  return new Set(rows.map((r: any) => r.productId as string));
}

// Drop-in replacement for applyInventoryMovement at every place a SALE or
// RETURN touches stock. A product without a recipe behaves exactly as before;
// one with a recipe consumes (or gives back) its ingredients instead.
// Ingredient usage never blocks a sale: the kitchen may sell before anyone
// logs a delivery, and the daily count exposes the gap.
export async function applyProductStock(params: MovementParams) {
  const lines = await params.tx.recipeLine.findMany({ where: { productId: params.productId } });
  if (lines.length === 0) return applyInventoryMovement(params);

  const units = new Prisma.Decimal(params.quantityChange); // negative on sale, positive on return
  const type = params.type === "RETURN" ? "SALE_RETURN" : params.type === "SALE" ? "SALE_USAGE" : "ADJUSTMENT";
  for (const line of lines as any[]) {
    await applyIngredientMovement({
      tx: params.tx,
      businessId: params.businessId,
      ingredientId: line.ingredientId,
      type,
      quantityChange: new Prisma.Decimal(line.quantity).mul(units),
      reason: params.reason,
      reference: params.reference,
      userId: params.userId,
      allowNegative: true,
    });
  }
  return { recipe: true as const };
}

export type { InventoryMovementType };

// How many of a dish the current ingredient stock could make: the scarcest
// ingredient decides. Ingredients at or below zero count as none.
export function portionsFromRecipe(
  lines: { quantity: Prisma.Decimal.Value; ingredient: { currentQuantity: Prisma.Decimal.Value } }[]
): number {
  if (lines.length === 0) return 0;
  let min = Infinity;
  for (const l of lines) {
    const need = new Prisma.Decimal(l.quantity);
    if (need.lessThanOrEqualTo(0)) continue;
    const have = Prisma.Decimal.max(new Prisma.Decimal(l.ingredient.currentQuantity), 0);
    min = Math.min(min, have.div(need).floor().toNumber());
  }
  return Number.isFinite(min) ? min : 0;
}

// For the product list the POS and tables screens read: a dish made from a
// recipe shows how many portions its ingredients allow (in currentQuantity,
// which is meaningless for it), plus hasRecipe so screens can tell.
export async function withRecipePortions<T extends { id: string; currentQuantity: number }>(
  db: Prisma.TransactionClient | { recipeLine: any },
  products: T[]
): Promise<(T & { hasRecipe: boolean })[]> {
  if (products.length === 0) return [];
  const lines: any[] = await (db as any).recipeLine.findMany({
    where: { productId: { in: products.map((p) => p.id) } },
    include: { ingredient: { select: { currentQuantity: true } } },
  });
  const byProduct = new Map<string, any[]>();
  for (const l of lines) byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), l]);
  return products.map((p) => {
    const recipe = byProduct.get(p.id);
    return recipe ? { ...p, currentQuantity: portionsFromRecipe(recipe), hasRecipe: true } : { ...p, hasRecipe: false };
  });
}
