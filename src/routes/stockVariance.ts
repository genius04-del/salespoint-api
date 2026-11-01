import { Router } from "express";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { resolveDateRange } from "../utils/dateRange";
import {
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

export default router;
