import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { requireRestaurantMode } from "../middleware/restaurantMode";
import { recordAudit } from "../utils/audit";
import {
  applyIngredientMovement,
  syncProductsUsingIngredient,
} from "../services/ingredientStock";
import { weightedAverageCost, wouldCreateCycle } from "../services/stockMath";
import { postIngredientPurchaseEntry, postShrinkageEntry, RECEIVE_PAID_WITH } from "../services/kitchenLedger";

const router = Router();
router.use(authenticate, requireRestaurantMode);

const qty = z.number().positive().max(1_000_000);

export function mapIngredientError(err: any): { status: number; error: string } | null {
  const m = err?.message as string | undefined;
  if (!m) return null;
  if (m === "INGREDIENT_NOT_FOUND") return { status: 404, error: "Ingredient not found" };
  if (m.startsWith("INSUFFICIENT_INGREDIENT:"))
    return { status: 409, error: `Not enough ${m.split(":")[1]} in stock. Receive stock first, or fix the quantity.` };
  return null;
}

// ---- GET /ingredients ----
router.get("/", requirePermission("stock.view", "stock.manage"), async (req, res) => {
  const includeInactive = req.query.includeInactive === "true";
  const ingredients = await prisma.ingredient.findMany({
    where: { businessId: req.auth!.businessId, ...(includeInactive ? {} : { isActive: true }) },
    include: { components: { include: { component: { select: { id: true, name: true, unit: true } } } } },
    orderBy: { name: "asc" },
  });
  return res.json({ ingredients });
});

// ---- POST /ingredients ----
const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  unit: z.string().trim().min(1).max(20).default("kg"),
  isPrepared: z.boolean().default(false),
  minStockLevel: z.number().min(0).default(0),
  costPerUnit: z.number().min(0).default(0),
  openingQuantity: z.number().min(0).default(0),
});

router.post("/", requirePermission("stock.manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  const businessId = req.auth!.businessId;

  const dup = await prisma.ingredient.findFirst({ where: { businessId, name: d.name } });
  if (dup) return res.status(409).json({ error: `You already have an ingredient called "${d.name}"` });

  const ingredient = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const created = await tx.ingredient.create({
      data: {
        businessId,
        name: d.name,
        unit: d.unit,
        isPrepared: d.isPrepared,
        minStockLevel: d.minStockLevel,
        costPerUnit: d.costPerUnit,
      },
    });
    if (d.openingQuantity > 0) {
      await applyIngredientMovement({
        tx,
        businessId,
        ingredientId: created.id,
        type: "OPENING_STOCK",
        quantityChange: d.openingQuantity,
        reason: "Opening stock",
        userId: req.auth!.userId,
      });
    }
    return created;
  });

  await recordAudit({ businessId, userId: req.auth!.userId, action: "INGREDIENT_CREATED", entity: "Ingredient", entityId: ingredient.id, metadata: { name: d.name } });
  return res.status(201).json({ ingredient });
});

// ---- PATCH /ingredients/:id ----
const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  unit: z.string().trim().min(1).max(20).optional(),
  minStockLevel: z.number().min(0).optional(),
  costPerUnit: z.number().min(0).optional(),
  isActive: z.boolean().optional(),
});

router.patch("/:id", requirePermission("stock.manage"), async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const businessId = req.auth!.businessId;

  const existing = await prisma.ingredient.findFirst({ where: { id: req.params.id, businessId } });
  if (!existing) return res.status(404).json({ error: "Ingredient not found" });

  if (parsed.data.name && parsed.data.name !== existing.name) {
    const dup = await prisma.ingredient.findFirst({ where: { businessId, name: parsed.data.name } });
    if (dup) return res.status(409).json({ error: `You already have an ingredient called "${parsed.data.name}"` });
  }

  const ingredient = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const updated = await tx.ingredient.update({ where: { id: existing.id }, data: parsed.data });
    if (parsed.data.costPerUnit !== undefined) await syncProductsUsingIngredient(tx, existing.id);
    return updated;
  });

  await recordAudit({ businessId, userId: req.auth!.userId, action: "INGREDIENT_UPDATED", entity: "Ingredient", entityId: existing.id, metadata: parsed.data });
  return res.json({ ingredient });
});

// ---- PUT /ingredients/:id/prep ----
// The standard make-up of a prepared item, per ONE unit of it.
const prepSchema = z.object({
  components: z
    .array(z.object({ ingredientId: z.string(), quantity: z.number().positive().max(1_000_000) }))
    .max(50),
});

router.put("/:id/prep", requirePermission("stock.manage"), async (req, res) => {
  const parsed = prepSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const businessId = req.auth!.businessId;

  const output = await prisma.ingredient.findFirst({ where: { id: req.params.id, businessId } });
  if (!output) return res.status(404).json({ error: "Ingredient not found" });
  if (!output.isPrepared) return res.status(400).json({ error: "Only prepared items (dough, sauce, chopped veg...) have a make-up" });

  const ids = parsed.data.components.map((c) => c.ingredientId);
  if (new Set(ids).size !== ids.length) return res.status(400).json({ error: "An ingredient is listed twice" });

  const found = await prisma.ingredient.findMany({ where: { id: { in: ids }, businessId } });
  if (found.length !== ids.length) return res.status(400).json({ error: "One or more ingredients not found" });

  const all = await prisma.prepComponent.findMany({
    where: { output: { businessId }, NOT: { outputId: output.id } },
    select: { outputId: true, componentId: true },
  });
  const edges = new Map<string, string[]>();
  for (const e of all) edges.set(e.outputId, [...(edges.get(e.outputId) ?? []), e.componentId]);
  for (const id of ids) {
    if (wouldCreateCycle(output.id, id, edges)) {
      return res.status(400).json({ error: "A prepared item can't be made from itself, directly or through another prepared item" });
    }
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.prepComponent.deleteMany({ where: { outputId: output.id } });
    if (parsed.data.components.length) {
      await tx.prepComponent.createMany({
        data: parsed.data.components.map((c) => ({ outputId: output.id, componentId: c.ingredientId, quantity: c.quantity })),
      });
    }
  });

  await recordAudit({ businessId, userId: req.auth!.userId, action: "PREP_RECIPE_SET", entity: "Ingredient", entityId: output.id });
  const components = await prisma.prepComponent.findMany({
    where: { outputId: output.id },
    include: { component: { select: { id: true, name: true, unit: true } } },
  });
  return res.json({ components });
});

// ---- POST /ingredients/:id/receive ---- stock coming in (a delivery / market run)
const receiveSchema = z.object({
  quantity: qty,
  totalCost: z.number().min(0).max(100_000_000).optional(),
  paidWith: z.enum(Object.keys(RECEIVE_PAID_WITH) as [keyof typeof RECEIVE_PAID_WITH, ...(keyof typeof RECEIVE_PAID_WITH)[]]).default("CASH"),
  note: z.string().max(200).optional(),
});

router.post("/:id/receive", requirePermission("stock.manage"), async (req, res) => {
  const parsed = receiveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const businessId = req.auth!.businessId;
  const { quantity, totalCost, paidWith, note } = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const ing = await tx.ingredient.findFirst({ where: { id: req.params.id, businessId } });
      if (!ing) throw new Error("INGREDIENT_NOT_FOUND");

      // New average cost first, so the movement row records the cost after this delivery.
      if (totalCost !== undefined && totalCost > 0) {
        const unitCost = new Prisma.Decimal(totalCost).div(quantity);
        const avg = weightedAverageCost(ing.currentQuantity, ing.costPerUnit, quantity, unitCost);
        await tx.ingredient.update({ where: { id: ing.id }, data: { costPerUnit: avg.toDecimalPlaces(4) } });
        await syncProductsUsingIngredient(tx, ing.id);
      }
      const moved = await applyIngredientMovement({
        tx, businessId, ingredientId: ing.id, type: "PURCHASE", quantityChange: quantity,
        reason: note ?? "Stock received", userId: req.auth!.userId,
      });
      if (totalCost && totalCost > 0) {
        await postIngredientPurchaseEntry({
          tx, businessId, amount: totalCost, paidWith,
          description: `Ingredient purchase: ${ing.name}`, sourceId: moved.movement.id, createdById: req.auth!.userId,
        });
      }
      return moved;
    });
    await recordAudit({ businessId, userId: req.auth!.userId, action: "INGREDIENT_RECEIVED", entity: "Ingredient", entityId: req.params.id, metadata: { quantity, totalCost } });
    return res.status(201).json({ newQuantity: result.newQuantity });
  } catch (err: any) {
    const mapped = mapIngredientError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.error });
    throw err;
  }
});

// ---- POST /ingredients/:id/waste ---- spoiled, spilled, burnt, staff meals
const wasteSchema = z.object({ quantity: qty, reason: z.string().trim().min(1).max(200) });

router.post("/:id/waste", requirePermission("stock.manage", "stock.produce"), async (req, res) => {
  const parsed = wasteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const businessId = req.auth!.businessId;

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const moved = await applyIngredientMovement({
        tx, businessId, ingredientId: req.params.id, type: "WASTE",
        quantityChange: -parsed.data.quantity, reason: parsed.data.reason, userId: req.auth!.userId,
      });
      const value = new Prisma.Decimal(parsed.data.quantity).mul(moved.ingredient.costPerUnit).toDecimalPlaces(2);
      await postShrinkageEntry({
        tx, businessId, net: value.neg(), description: `Waste: ${moved.ingredient.name} (${parsed.data.reason})`,
        sourceType: "INGREDIENT_WASTE", sourceId: moved.movement.id, createdById: req.auth!.userId,
      });
      return moved;
    });
    await recordAudit({ businessId, userId: req.auth!.userId, action: "INGREDIENT_WASTE", entity: "Ingredient", entityId: req.params.id, metadata: parsed.data });
    return res.status(201).json({ newQuantity: result.newQuantity });
  } catch (err: any) {
    const mapped = mapIngredientError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.error });
    throw err;
  }
});

// ---- GET /ingredients/:id/movements ----
router.get("/:id/movements", requirePermission("stock.view", "stock.manage"), async (req, res) => {
  const movements = await prisma.ingredientMovement.findMany({
    where: { businessId: req.auth!.businessId, ingredientId: req.params.id },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return res.json({ movements });
});

export default router;
