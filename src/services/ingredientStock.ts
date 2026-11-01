import { Prisma, IngredientMovementType } from "@prisma/client";
import { recipeCost } from "./stockMath";

interface Params {
  tx: Prisma.TransactionClient;
  businessId: string;
  ingredientId: string;
  type: IngredientMovementType;
  quantityChange: Prisma.Decimal.Value; // signed
  reason?: string;
  reference?: string;
  userId?: string | null;
  allowNegative?: boolean; // default false
}

// The only place an Ingredient.currentQuantity may change — same rule as
// applyInventoryMovement for products: update + movement row, one transaction.
export async function applyIngredientMovement(p: Params) {
  const ingredient = await p.tx.ingredient.findFirst({
    where: { id: p.ingredientId, businessId: p.businessId },
  });
  if (!ingredient) throw new Error("INGREDIENT_NOT_FOUND");

  const change = new Prisma.Decimal(p.quantityChange);
  const previous = new Prisma.Decimal(ingredient.currentQuantity);
  const next = previous.add(change);
  if (next.lessThan(0) && !p.allowNegative) {
    throw new Error(`INSUFFICIENT_INGREDIENT:${ingredient.name}`);
  }

  await p.tx.ingredient.update({ where: { id: ingredient.id }, data: { currentQuantity: next } });
  const movement = await p.tx.ingredientMovement.create({
    data: {
      businessId: p.businessId,
      ingredientId: ingredient.id,
      type: p.type,
      quantityChange: change,
      previousQuantity: previous,
      newQuantity: next,
      unitCost: ingredient.costPerUnit,
      reason: p.reason,
      reference: p.reference,
      userId: p.userId ?? null,
    },
  });
  return { movement, ingredient, previousQuantity: previous, newQuantity: next };
}

// Keeps Product.costPrice equal to the recipe's current cost, so the existing
// sale journal (Dr COGS / Cr Inventory from costPrice) books ingredient cost
// with no changes. Call after a recipe is saved or an ingredient cost moves.
export async function syncRecipeProductCost(tx: Prisma.TransactionClient, productId: string) {
  const lines = await tx.recipeLine.findMany({
    where: { productId },
    include: { ingredient: { select: { costPerUnit: true } } },
  });
  if (lines.length === 0) return null;
  const costById = new Map<string, Prisma.Decimal.Value>(lines.map((l: any) => [l.ingredientId as string, l.ingredient.costPerUnit]));
  const cost = recipeCost(
    lines.map((l: any) => ({ ingredientId: l.ingredientId, quantity: l.quantity })),
    costById
  ).toDecimalPlaces(2);
  await tx.product.update({ where: { id: productId }, data: { costPrice: cost } });
  return cost;
}

export async function syncProductsUsingIngredient(tx: Prisma.TransactionClient, ingredientId: string) {
  const rows = await tx.recipeLine.findMany({ where: { ingredientId }, select: { productId: true } });
  for (const productId of new Set<string>(rows.map((r: any) => r.productId as string))) {
    await syncRecipeProductCost(tx, productId);
  }
}
