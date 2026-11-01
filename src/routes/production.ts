import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { requireRestaurantMode } from "../middleware/restaurantMode";
import { recordAudit } from "../utils/audit";
import { applyIngredientMovement } from "../services/ingredientStock";
import { scaleComponents, weightedAverageCost } from "../services/stockMath";
import { mapIngredientError } from "./ingredients";

const router = Router();
router.use(authenticate, requireRestaurantMode);

async function loadStandard(db: Prisma.TransactionClient | typeof prisma, businessId: string, outputId: string, quantity: number) {
  const output = await (db as any).ingredient.findFirst({
    where: { id: outputId, businessId },
    include: { components: { include: { component: true } } },
  });
  if (!output) return null;
  const scaled = scaleComponents(
    output.components.map((c: any) => ({ ingredientId: c.componentId, quantity: c.quantity })),
    quantity
  );
  const byId = new Map<string, any>(output.components.map((c: any) => [c.componentId, c.component]));
  return { output, scaled, byId };
}

// ---- GET /production/preview?outputId=&quantity= ----
// What a run would use, and whether there is enough of each ingredient.
router.get("/preview", requirePermission("stock.view", "stock.produce"), async (req, res) => {
  const quantity = Number(req.query.quantity);
  if (!req.query.outputId || !(quantity > 0)) return res.status(400).json({ error: "outputId and a positive quantity are required" });
  const std = await loadStandard(prisma, req.auth!.businessId, String(req.query.outputId), quantity);
  if (!std) return res.status(404).json({ error: "Prepared item not found" });
  const lines = std.scaled.map((l) => {
    const ing = std.byId.get(l.ingredientId);
    return {
      ingredientId: l.ingredientId, name: ing.name, unit: ing.unit,
      standardQuantity: l.quantity.toString(), onHand: ing.currentQuantity.toString(),
      enough: new Prisma.Decimal(ing.currentQuantity).greaterThanOrEqualTo(l.quantity),
    };
  });
  return res.json({ output: { id: std.output.id, name: std.output.name, unit: std.output.unit }, lines });
});

// ---- POST /production ---- record a run (the stock journal entry)
const runSchema = z.object({
  outputId: z.string(),
  quantity: z.number().positive().max(1_000_000),
  // Optional: what was REALLY used, if it differs from the standard make-up.
  lines: z.array(z.object({ ingredientId: z.string(), quantityUsed: z.number().min(0).max(1_000_000) })).max(50).optional(),
  notes: z.string().max(300).optional(),
  allowShortage: z.boolean().default(false),
});

router.post("/", requirePermission("stock.produce"), async (req, res) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const businessId = req.auth!.businessId;
  const { outputId, quantity, notes, allowShortage } = parsed.data;

  try {
    const batch = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const std = await loadStandard(tx, businessId, outputId, quantity);
      if (!std) throw new Error("INGREDIENT_NOT_FOUND");
      if (!std.output.isPrepared) throw new Error("NOT_PREPARED");

      const standardById = new Map(std.scaled.map((l) => [l.ingredientId, l.quantity]));
      let used: { ingredientId: string; quantityUsed: Prisma.Decimal }[];
      if (parsed.data.lines) {
        used = parsed.data.lines.filter((l) => l.quantityUsed > 0).map((l) => ({ ingredientId: l.ingredientId, quantityUsed: new Prisma.Decimal(l.quantityUsed) }));
      } else {
        used = std.scaled.map((l) => ({ ingredientId: l.ingredientId, quantityUsed: l.quantity }));
      }
      if (used.length === 0) throw new Error("NO_MAKEUP");
      if (new Set(used.map((u) => u.ingredientId)).has(outputId)) throw new Error("SELF_USE");

      const batch = await tx.productionBatch.create({
        data: { businessId, outputId, quantityProduced: quantity, notes, producedById: req.auth!.userId },
      });

      let totalCost = new Prisma.Decimal(0);
      for (const u of used) {
        const moved = await applyIngredientMovement({
          tx, businessId, ingredientId: u.ingredientId, type: "PRODUCTION_OUT",
          quantityChange: u.quantityUsed.neg(), reason: `Production: ${std.output.name}`,
          reference: batch.id, userId: req.auth!.userId, allowNegative: allowShortage,
        });
        const unitCost = new Prisma.Decimal(moved.ingredient.costPerUnit);
        totalCost = totalCost.add(unitCost.mul(u.quantityUsed));
        await tx.productionBatchLine.create({
          data: {
            batchId: batch.id, ingredientId: u.ingredientId, quantityUsed: u.quantityUsed,
            standardQuantity: standardById.get(u.ingredientId) ?? 0, unitCost,
          },
        });
      }

      // The made item enters stock at what this run actually cost per unit.
      const fresh = await tx.ingredient.findFirstOrThrow({ where: { id: outputId, businessId } });
      const unitCost = totalCost.div(quantity);
      await tx.ingredient.update({
        where: { id: outputId },
        data: { costPerUnit: weightedAverageCost(fresh.currentQuantity, fresh.costPerUnit, quantity, unitCost).toDecimalPlaces(4) },
      });
      await applyIngredientMovement({
        tx, businessId, ingredientId: outputId, type: "PRODUCTION_IN", quantityChange: quantity,
        reason: "Production run", reference: batch.id, userId: req.auth!.userId,
      });
      return tx.productionBatch.update({ where: { id: batch.id }, data: { totalCost: totalCost.toDecimalPlaces(2) } });
    });

    await recordAudit({ businessId, userId: req.auth!.userId, action: "PRODUCTION_RECORDED", entity: "ProductionBatch", entityId: batch.id, metadata: { outputId, quantity } });
    return res.status(201).json({ batch });
  } catch (err: any) {
    if (err.message === "NOT_PREPARED") return res.status(400).json({ error: "Only prepared items can be produced" });
    if (err.message === "NO_MAKEUP") return res.status(400).json({ error: "This item has no make-up yet. Set what it is made from first, or enter the amounts used." });
    if (err.message === "SELF_USE") return res.status(400).json({ error: "A prepared item can't be made from itself" });
    const mapped = mapIngredientError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.error });
    throw err;
  }
});

// ---- GET /production ---- recent runs, newest first
router.get("/", requirePermission("stock.view", "stock.produce"), async (req, res) => {
  const businessId = req.auth!.businessId;
  const batches = await prisma.productionBatch.findMany({
    where: { businessId },
    include: {
      output: { select: { name: true, unit: true } },
      lines: { include: { ingredient: { select: { name: true, unit: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const userIds = [...new Set(batches.map((b: any) => b.producedById).filter(Boolean))] as string[];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds }, businessId }, select: { id: true, name: true } }) : [];
  const nameById = new Map(users.map((u: any) => [u.id, u.name]));
  return res.json({
    batches: batches.map((b: any) => ({ ...b, producedByName: b.producedById ? nameById.get(b.producedById) ?? null : null })),
  });
});

export default router;
