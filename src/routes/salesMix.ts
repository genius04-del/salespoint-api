import { Router } from "express";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { resolveDateRange } from "../utils/dateRange";
import { sendCsv } from "../utils/csv";
import { buildSalesMix, SalesMixRow } from "../services/salesMix";

const router = Router();
router.use(authenticate);

// ---- GET /reports/sales-mix ----
// What was sold: every product with units, revenue, cost and profit, plus a
// category roll-up. Period: ?range=today|week|month|year, or
// ?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD, or ?dayId=<business day id>
// to see exactly one trading day. Optional ?cashierId= narrows to one
// cashier. Add &format=csv for a spreadsheet. Cancelled sales never count.
router.get("/", requirePermission("reports.view", "day.close"), async (req, res) => {
  const businessId = req.auth!.businessId;

  let from: Date;
  let to: Date;
  let label: string;

  if (req.query.dayId) {
    const day = await prisma.businessDay.findFirst({
      where: { id: String(req.query.dayId), businessId },
      select: { openedAt: true, closedAt: true },
    });
    if (!day) return res.status(404).json({ error: "Business day not found" });
    from = day.openedAt;
    to = day.closedAt ?? new Date();
    label = "day";
  } else {
    try {
      const range = resolveDateRange(req.query, "today");
      from = range.from;
      to = range.to;
      label = range.label;
    } catch {
      return res.status(400).json({
        error: "Invalid date range. Use range=today|week|month|year, or range=custom with from and to (YYYY-MM-DD).",
      });
    }
  }

  const saleWhere: Record<string, unknown> = {
    businessId,
    status: "COMPLETED",
    createdAt: { gte: from, lte: to },
  };
  if (req.query.cashierId) saleWhere.cashierId = String(req.query.cashierId);

  const [items, orders] = await Promise.all([
    prisma.saleItem.findMany({
      where: { sale: saleWhere },
      select: {
        productId: true,
        productName: true,
        quantity: true,
        lineTotal: true,
        unitCost: true,
        product: { select: { category: { select: { name: true } } } },
      },
    }),
    prisma.sale.count({ where: saleWhere }),
  ]);

  const rows: SalesMixRow[] = (items as any[]).map((i) => ({
    productId: i.productId,
    productName: i.productName,
    categoryName: i.product?.category?.name ?? null,
    quantity: i.quantity,
    lineTotal: Number(i.lineTotal),
    unitCost: Number(i.unitCost),
  }));

  const mix = buildSalesMix(rows);

  if (req.query.format === "csv") {
    return sendCsv(
      res,
      `sales-mix-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv`,
      mix.products.map((p) => ({
        product: p.productName,
        category: p.category,
        quantity: p.quantity,
        revenue: p.revenue,
        cost: p.cost,
        profit: p.profit,
        quantity_share_pct: p.quantitySharePct,
        revenue_share_pct: p.revenueSharePct,
      }))
    );
  }

  return res.json({ period: { label, from, to }, orders, ...mix });
});

export default router;
