import { Router } from "express";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { resolveDateRange } from "../utils/dateRange";
import {
  buildMovementReport,
  rollUpCountVariance,
  summariseCountVariance,
  rollUpProductionUsage,
} from "../services/stockVariance";

const router = Router();
router.use(authenticate);

// ---- GET /stock-variance ----
// Where stock went missing (or turned up) over a period, from three angles:
//  - items: approved stock counts, counted vs. expected (works for products and ingredients)
//  - waste: ingredients written off
//  - production: ingredients used beyond the standard make-up
// ?range=today|week|month|year, or range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/", requirePermission("stock.view", "reports.stock"), async (req, res) => {
  const businessId = req.auth!.businessId;
  let range;
  try {
    range = resolveDateRange(req.query, "month");
  } catch {
    return res.status(400).json({ error: "Invalid date range. Use range=today|week|month|year, or range=custom with from and to (YYYY-MM-DD)." });
  }

  const [counts, wasteMoves, batchLines] = await Promise.all([
    prisma.stockCount.findMany({
      where: { businessId, status: "APPROVED", reviewedAt: { gte: range.from, lte: range.to } },
      include: { lines: true },
    }),
    prisma.ingredientMovement.findMany({
      where: { businessId, type: "WASTE", createdAt: { gte: range.from, lte: range.to } },
      include: { ingredient: { select: { name: true, unit: true } } },
    }),
    prisma.productionBatchLine.findMany({
      where: { batch: { businessId, createdAt: { gte: range.from, lte: range.to } } },
      include: { ingredient: { select: { name: true, unit: true } } },
    }),
  ]);

  const items = rollUpCountVariance(
    counts.flatMap((c: any) => c.lines.map((l: any) => ({ ...l, countedAt: c.reviewedAt })))
  );
  const countSummary = summariseCountVariance(items);

  const wasteMap = new Map<string, { ingredientId: string; name: string; unit: string; quantity: number; value: number }>();
  for (const m of wasteMoves as any[]) {
    const q = Math.abs(Number(m.quantityChange));
    const e = wasteMap.get(m.ingredientId) ?? { ingredientId: m.ingredientId, name: m.ingredient.name, unit: m.ingredient.unit, quantity: 0, value: 0 };
    e.quantity += q;
    e.value += q * Number(m.unitCost);
    wasteMap.set(m.ingredientId, e);
  }
  const waste = [...wasteMap.values()]
    .map((w) => ({ ...w, value: Math.round(w.value * 100) / 100 }))
    .sort((a, b) => b.value - a.value);

  const production = rollUpProductionUsage(
    (batchLines as any[]).map((l) => ({
      ingredientId: l.ingredientId, name: l.ingredient.name, unit: l.ingredient.unit,
      quantityUsed: l.quantityUsed, standardQuantity: l.standardQuantity, unitCost: l.unitCost,
    }))
  );

  return res.json({
    range: { from: range.from, to: range.to, label: range.label },
    summary: {
      countsApproved: counts.length,
      shortageValue: countSummary.loss,
      surplusValue: countSummary.gain,
      netCountValue: countSummary.net,
      wasteValue: Math.round(waste.reduce((s, w) => s + w.value, 0) * 100) / 100,
      productionOverUseValue: Math.round(production.reduce((s, p) => s + p.value, 0) * 100) / 100,
    },
    items,
    waste,
    production,
  });
});

// ---- GET /stock-variance/report ----
// Per item for a date range: opening, in, out, waste, theoretical closing,
// actual closing (after approved counts) and the variance.
// ?from=YYYY-MM-DD&to=YYYY-MM-DD (range=custom), or range=today|week|month|year
router.get("/report", requirePermission("stock.view", "reports.stock"), async (req, res) => {
  const businessId = req.auth!.businessId;
  let range;
  try {
    const q: any = { ...req.query };
    if (q.from && q.to && !q.range) q.range = "custom";
    range = resolveDateRange(q, "today");
  } catch {
    return res.status(400).json({ error: "Invalid date range. Pick a start and an end date." });
  }

  const [ingredients, products, ingMoves, prodMoves, counts] = await Promise.all([
    prisma.ingredient.findMany({ where: { businessId }, select: { id: true, name: true, unit: true, category: true, currentQuantity: true, costPerUnit: true } }),
    // Dishes with a recipe are tracked through their ingredients.
    prisma.product.findMany({
      where: { businessId, recipeLines: { none: {} } },
      select: { id: true, name: true, unit: true, currentQuantity: true, costPrice: true, category: { select: { name: true } } },
    }),
    prisma.ingredientMovement.findMany({ where: { businessId, createdAt: { gte: range.from } }, orderBy: { createdAt: "asc" } }),
    prisma.inventoryMovement.findMany({ where: { businessId, createdAt: { gte: range.from } }, orderBy: { createdAt: "asc" } }),
    prisma.stockCount.findMany({
      where: { businessId, status: "APPROVED", reviewedAt: { gte: range.from, lte: range.to } },
      select: { lines: { select: { productId: true, ingredientId: true, counted: true } } },
    }),
  ]);

  const countedIds = new Set<string>();
  for (const c of counts as any[]) {
    for (const l of c.lines) {
      if (l.counted === null) continue;
      if (l.ingredientId) countedIds.add(`I:${l.ingredientId}`);
      if (l.productId) countedIds.add(`P:${l.productId}`);
    }
  }

  const rows = buildMovementReport(
    [
      ...(ingredients as any[]).map((i) => ({
        itemType: "INGREDIENT" as const, itemId: `I:${i.id}`, name: i.name, unit: i.unit, category: i.category ?? null,
        currentQuantity: i.currentQuantity, unitCost: i.costPerUnit,
      })),
      ...(products as any[]).map((p) => ({
        itemType: "PRODUCT" as const, itemId: `P:${p.id}`, name: p.name, unit: p.unit, category: p.category?.name ?? null,
        currentQuantity: p.currentQuantity, unitCost: p.costPrice,
      })),
    ],
    [
      ...(ingMoves as any[]).map((m) => ({
        itemId: `I:${m.ingredientId}`,
        kind: (m.type === "COUNT_ADJUSTMENT" ? "COUNT" : m.type === "WASTE" ? "WASTE" : "OTHER") as "COUNT" | "WASTE" | "OTHER",
        change: m.quantityChange, previous: m.previousQuantity, next: m.newQuantity, at: m.createdAt,
      })),
      ...(prodMoves as any[]).map((m) => ({
        itemId: `P:${m.productId}`,
        kind: (m.type === "ADJUSTMENT" && String(m.reason ?? "").startsWith("Stock count adjustment")
          ? "COUNT"
          : m.type === "DAMAGE"
            ? "WASTE"
            : "OTHER") as "COUNT" | "WASTE" | "OTHER",
        change: m.quantityChange, previous: m.previousQuantity, next: m.newQuantity, at: m.createdAt,
      })),
    ],
    countedIds,
    range.from,
    range.to
  ).map((r) => ({ ...r, itemId: r.itemId.slice(2) }));

  const sum = (f: (r: (typeof rows)[number]) => number) => Math.round(rows.reduce((s, r) => s + f(r), 0) * 100) / 100;
  return res.json({
    range: { from: range.from, to: range.to, label: range.label },
    rows,
    totals: {
      shortageValue: sum((r) => Math.min(r.varianceValue ?? 0, 0)),
      surplusValue: sum((r) => Math.max(r.varianceValue ?? 0, 0)),
      itemsCounted: rows.filter((r) => r.counted).length,
      itemsShort: rows.filter((r) => (r.variance ?? 0) < 0).length,
    },
  });
});

export default router;
