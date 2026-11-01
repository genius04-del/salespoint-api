import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { requireRestaurantMode } from "../middleware/restaurantMode";
import { recordAudit } from "../utils/audit";
import { syncRecipeProductCost } from "../services/ingredientStock";
import { recipeCost } from "../services/stockMath";

const router = Router();
router.use(authenticate, requireRestaurantMode);

// ---- GET /recipes ---- every active product with a summary of its recipe
router.get("/", requirePermission("stock.view", "stock.manage"), async (req, res) => {
  const businessId = req.auth!.businessId;
  const products = await prisma.product.findMany({
    where: { businessId, isActive: true },
    select: {
      id: true, name: true, sellingPrice: true, costPrice: true,
      recipeLines: { select: { ingredientId: true, quantity: true, ingredient: { select: { costPerUnit: true } } } },
    },
    orderBy: { name: "asc" },
  });
  const rows = products.map((p: any) => {
    const costById = new Map<string, Prisma.Decimal.Value>(p.recipeLines.map((l: any) => [l.ingredientId, l.ingredient.costPerUnit]));
    const cost = recipeCost(p.recipeLines.map((l: any) => ({ ingredientId: l.ingredientId, quantity: l.quantity })), costById);
    const price = Number(p.sellingPrice);
    return {
      productId: p.id,
      name: p.name,
      sellingPrice: p.sellingPrice,
      hasRecipe: p.recipeLines.length > 0,
      ingredientCount: p.recipeLines.length,
      recipeCost: cost.toDecimalPlaces(2).toString(),
      marginPercent: p.recipeLines.length && price > 0 ? Math.round(((price - cost.toNumber()) / price) * 1000) / 10 : null,
    };
  });
  return res.json({ recipes: rows });
});

// ---- GET /recipes/:productId ----
router.get("/:productId", requirePermission("stock.view", "stock.manage"), async (req, res) => {
  const product = await prisma.product.findFirst({
    where: { id: req.params.productId, businessId: req.auth!.businessId },
    select: { id: true, name: true, sellingPrice: true },
  });
  if (!product) return res.status(404).json({ error: "Product not found" });
  const lines = await prisma.recipeLine.findMany({
    where: { productId: product.id },
    include: { ingredient: { select: { id: true, name: true, unit: true, costPerUnit: true } } },
  });
  return res.json({ product, lines });
});

// ---- PUT /recipes/:productId ---- replace the recipe; [] removes it
const putSchema = z.object({
  lines: z.array(z.object({ ingredientId: z.string(), quantity: z.number().positive().max(1_000_000) })).max(50),
});

router.put("/:productId", requirePermission("stock.manage"), async (req, res) => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const businessId = req.auth!.businessId;

  const product = await prisma.product.findFirst({ where: { id: req.params.productId, businessId } });
  if (!product) return res.status(404).json({ error: "Product not found" });

  const ids = parsed.data.lines.map((l) => l.ingredientId);
  if (new Set(ids).size !== ids.length) return res.status(400).json({ error: "An ingredient is listed twice" });
  const found = await prisma.ingredient.findMany({ where: { id: { in: ids }, businessId } });
  if (found.length !== ids.length) return res.status(400).json({ error: "One or more ingredients not found" });

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.recipeLine.deleteMany({ where: { productId: product.id } });
    if (parsed.data.lines.length) {
      await tx.recipeLine.createMany({
        data: parsed.data.lines.map((l) => ({ productId: product.id, ingredientId: l.ingredientId, quantity: l.quantity })),
      });
      await syncRecipeProductCost(tx, product.id);
    }
  });

  await recordAudit({
    businessId, userId: req.auth!.userId, action: "RECIPE_SET", entity: "Product", entityId: product.id,
    metadata: { ingredients: parsed.data.lines.length },
  });
  return res.json({ message: parsed.data.lines.length ? "Recipe saved" : "Recipe removed" });
});

export default router;
