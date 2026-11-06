import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import { applyInventoryMovement } from "../services/inventory";
import { applyIngredientMovement } from "../services/ingredientStock";
import { countLineVariance } from "../services/stockMath";
import { countPendingSales, getDeductionState } from "../services/stockDeduction";
import { postShrinkageEntry } from "../services/kitchenLedger";

const router = Router();
router.use(authenticate);

// ---- POST /stock-counts ---- start a count: snapshot what the system expects
const startSchema = z.object({
  scope: z.enum(["ALL", "INGREDIENTS", "PRODUCTS"]).default("ALL"),
  notes: z.string().max(300).optional(),
});

router.post("/", requirePermission("stock.count"), async (req, res) => {
  const parsed = startSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const businessId = req.auth!.businessId;

  const open = await prisma.stockCount.findFirst({ where: { businessId, status: "DRAFT" }, select: { id: true } });
  if (open) {
    return res.status(409).json({ error: "A count is already in progress. Finish or delete it first.", countId: open.id });
  }

  // Day-end restaurants: the count compares against stock AFTER the day's sales are
  // taken off, so the difference is a real variance and not just the sales.
  const deduction = await getDeductionState(prisma as unknown as Prisma.TransactionClient, businessId);
  if (deduction.dayEnd && deduction.pending) {
    return res.status(409).json({
      error: `Deduction SD-${String(deduction.pending.number).padStart(4, "0")} has not been saved yet. Upload its file in Stock Adjustment first, then count.`,
      code: "DEDUCTION_NOT_APPLIED",
    });
  }
  if (deduction.dayEnd) {
    const pending = await countPendingSales(prisma as unknown as Prisma.TransactionClient, businessId, deduction);
    if (pending > 0) {
      return res.status(409).json({
        error: `${pending} sale${pending === 1 ? " has" : "s have"} not been deducted from stock yet. Deduct sales from stock first, then count.`,
        code: "SALES_NOT_DEDUCTED",
      });
    }
  }

  const { scope } = parsed.data;
  const [products, ingredients] = await Promise.all([
    scope === "INGREDIENTS"
      ? []
      : prisma.product.findMany({
          // Dishes made from a recipe are counted through their ingredients.
          where: { businessId, isActive: true, recipeLines: { none: {} } },
          select: { id: true, name: true, unit: true, currentQuantity: true, costPrice: true, category: { select: { name: true } } },
          orderBy: { name: "asc" },
        }),
    scope === "PRODUCTS"
      ? []
      : prisma.ingredient.findMany({
          where: { businessId, isActive: true },
          select: { id: true, name: true, unit: true, currentQuantity: true, costPerUnit: true, category: true },
          orderBy: { name: "asc" },
        }),
  ]);

  if (products.length + ingredients.length === 0) {
    return res.status(400).json({ error: "There is nothing to count yet. Add products or ingredients first." });
  }

  const count = await prisma.stockCount.create({
    data: {
      businessId,
      scope,
      notes: parsed.data.notes,
      countedById: req.auth!.userId,
      lines: {
        create: [
          ...ingredients.map((i: any) => ({
            itemType: "INGREDIENT" as const, ingredientId: i.id, itemName: i.name, unit: i.unit, category: i.category ?? null,
            expected: i.currentQuantity, unitCost: i.costPerUnit,
          })),
          ...products.map((p: any) => ({
            itemType: "PRODUCT" as const, productId: p.id, itemName: p.name, unit: p.unit, category: p.category?.name ?? null,
            expected: p.currentQuantity, unitCost: p.costPrice,
          })),
        ],
      },
    },
  });

  await recordAudit({ businessId, userId: req.auth!.userId, action: "STOCK_COUNT_STARTED", entity: "StockCount", entityId: count.id });
  return res.status(201).json({ count });
});

// ---- GET /stock-counts ----
router.get("/", requirePermission("stock.view", "stock.count", "stock.approve"), async (req, res) => {
  const businessId = req.auth!.businessId;
  const counts = await prisma.stockCount.findMany({
    where: { businessId, ...(req.query.status ? { status: String(req.query.status) as any } : {}) },
    include: { _count: { select: { lines: true } } },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  const ids = [...new Set(counts.flatMap((c: any) => [c.countedById, c.reviewedById]).filter(Boolean))] as string[];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids }, businessId }, select: { id: true, name: true } }) : [];
  const nameById = new Map(users.map((u: any) => [u.id, u.name]));
  return res.json({
    counts: counts.map((c: any) => ({
      ...c,
      countedByName: nameById.get(c.countedById) ?? null,
      reviewedByName: c.reviewedById ? nameById.get(c.reviewedById) ?? null : null,
    })),
  });
});

async function loadCount(businessId: string, id: string) {
  return prisma.stockCount.findFirst({
    where: { id, businessId },
    include: { lines: { orderBy: [{ itemType: "asc" }, { itemName: "asc" }] } },
  });
}

// ---- GET /stock-counts/:id ----
router.get("/:id", requirePermission("stock.view", "stock.count", "stock.approve"), async (req, res) => {
  const count = await loadCount(req.auth!.businessId, req.params.id);
  if (!count) return res.status(404).json({ error: "Count not found" });
  return res.json({ count });
});

// ---- PUT /stock-counts/:id/lines ---- enter physical quantities (null = not counted)
const linesSchema = z.object({
  lines: z.array(z.object({ lineId: z.string(), counted: z.number().min(0).max(100_000_000).nullable() })).min(1).max(2000),
});

router.put("/:id/lines", requirePermission("stock.count"), async (req, res) => {
  const parsed = linesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const count = await loadCount(req.auth!.businessId, req.params.id);
  if (!count) return res.status(404).json({ error: "Count not found" });
  if (count.status !== "DRAFT") return res.status(409).json({ error: `This count is ${count.status} and can't be edited` });

  const byId = new Map(count.lines.map((l: any) => [l.id, l]));
  for (const input of parsed.data.lines) {
    const line: any = byId.get(input.lineId);
    if (!line) return res.status(400).json({ error: "A line does not belong to this count" });
    if (input.counted !== null && line.itemType === "PRODUCT" && !Number.isInteger(input.counted)) {
      return res.status(400).json({ error: `${line.itemName} is counted in whole units` });
    }
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const input of parsed.data.lines) {
      const line: any = byId.get(input.lineId);
      if (input.counted === null) {
        await tx.stockCountLine.update({ where: { id: line.id }, data: { counted: null, variance: null, varianceValue: null } });
      } else {
        const { variance, value } = countLineVariance(line.expected, input.counted, line.unitCost);
        await tx.stockCountLine.update({ where: { id: line.id }, data: { counted: input.counted, variance, varianceValue: value } });
      }
    }
  });
  return res.json({ message: "Saved" });
});

// ---- DELETE /stock-counts/:id ---- throw away a draft
router.delete("/:id", requirePermission("stock.count"), async (req, res) => {
  const count = await prisma.stockCount.findFirst({ where: { id: req.params.id, businessId: req.auth!.businessId } });
  if (!count) return res.status(404).json({ error: "Count not found" });
  if (count.status !== "DRAFT") return res.status(409).json({ error: "Only a draft count can be deleted" });
  await prisma.stockCount.delete({ where: { id: count.id } });
  return res.json({ message: "Count deleted" });
});

// ---- POST /stock-counts/:id/submit ----
router.post("/:id/submit", requirePermission("stock.count"), async (req, res) => {
  const count = await loadCount(req.auth!.businessId, req.params.id);
  if (!count) return res.status(404).json({ error: "Count not found" });
  if (count.status !== "DRAFT") return res.status(409).json({ error: `This count is already ${count.status}` });
  if (!count.lines.some((l: any) => l.counted != null)) {
    return res.status(400).json({ error: "Enter at least one counted quantity before submitting" });
  }
  const updated = await prisma.stockCount.update({
    where: { id: count.id },
    data: { status: "SUBMITTED", submittedAt: new Date() },
  });
  await recordAudit({ businessId: req.auth!.businessId, userId: req.auth!.userId, action: "STOCK_COUNT_SUBMITTED", entity: "StockCount", entityId: count.id });
  return res.json({ count: updated });
});

// ---- POST /stock-counts/:id/approve ----
// Adjusts each counted item by (counted - expected-at-start), so sales made
// while counting are kept, and books the NET value of the differences.
router.post("/:id/approve", requirePermission("stock.approve"), async (req, res) => {
  const businessId = req.auth!.businessId;
  const count = await loadCount(businessId, req.params.id);
  if (!count) return res.status(404).json({ error: "Count not found" });
  if (count.status !== "SUBMITTED") return res.status(409).json({ error: `Only a submitted count can be approved (this one is ${count.status})` });

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Claim it first, so two managers approving at once can't adjust stock twice.
    const claimed = await tx.stockCount.updateMany({
      where: { id: count.id, status: "SUBMITTED" },
      data: { status: "APPROVED", reviewedById: req.auth!.userId, reviewedAt: new Date() },
    });
    if (claimed.count !== 1) throw new Error("ALREADY_REVIEWED");

    let net = new Prisma.Decimal(0);
    for (const line of count.lines as any[]) {
      if (line.counted == null || line.variance == null) continue;
      const variance = new Prisma.Decimal(line.variance);
      if (variance.isZero()) continue;
      net = net.add(new Prisma.Decimal(line.varianceValue ?? 0));
      const reason = `Stock count adjustment (${line.itemName})`;
      if (line.itemType === "PRODUCT" && line.productId) {
        await applyInventoryMovement({
          tx, businessId, productId: line.productId, type: "ADJUSTMENT",
          quantityChange: variance.toNumber(), reason, reference: count.id,
          userId: req.auth!.userId, allowNegativeStock: true,
        });
      } else if (line.ingredientId) {
        await applyIngredientMovement({
          tx, businessId, ingredientId: line.ingredientId, type: "COUNT_ADJUSTMENT",
          quantityChange: variance, reason, reference: count.id, userId: req.auth!.userId, allowNegative: true,
        });
      }
    }

    const entry = await postShrinkageEntry({
      tx, businessId, net, description: `Stock count ${count.id.slice(0, 8)} variance`,
      sourceType: "STOCK_COUNT", sourceId: count.id, createdById: req.auth!.userId,
    });
    return tx.stockCount.update({
      where: { id: count.id },
      data: { totalVarianceValue: net, journalEntryId: entry?.id ?? null },
    });
  }).catch((err: any) => {
    if (err.message === "ALREADY_REVIEWED") return null;
    throw err;
  });

  if (!result) return res.status(409).json({ error: "This count was already reviewed" });
  await recordAudit({
    businessId, userId: req.auth!.userId, action: "STOCK_COUNT_APPROVED", entity: "StockCount", entityId: count.id,
    metadata: { netValue: String(result.totalVarianceValue) },
  });
  return res.json({ count: result });
});

// ---- POST /stock-counts/:id/reject ---- sends it back; stock is untouched
router.post("/:id/reject", requirePermission("stock.approve"), async (req, res) => {
  const parsed = z.object({ note: z.string().trim().min(1).max(300) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Say why the count is rejected" });
  const count = await prisma.stockCount.findFirst({ where: { id: req.params.id, businessId: req.auth!.businessId } });
  if (!count) return res.status(404).json({ error: "Count not found" });
  if (count.status !== "SUBMITTED") return res.status(409).json({ error: `Only a submitted count can be rejected (this one is ${count.status})` });
  const updated = await prisma.stockCount.update({
    where: { id: count.id },
    data: { status: "REJECTED", reviewedById: req.auth!.userId, reviewedAt: new Date(), reviewNote: parsed.data.note },
  });
  await recordAudit({ businessId: req.auth!.businessId, userId: req.auth!.userId, action: "STOCK_COUNT_REJECTED", entity: "StockCount", entityId: count.id, metadata: { note: parsed.data.note } });
  return res.json({ count: updated });
});

export default router;
