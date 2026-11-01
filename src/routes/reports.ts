import { Router, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { resolveDateRange, DateRange } from "../utils/dateRange";
import { sendCsv } from "../utils/csv";
import { balanceOf, summarizeProfit, round2 } from "../services/financials";
import { accountMovements } from "../services/accountMovements";
import { ACCOUNT_CODES } from "../services/journal";

const router = Router();
router.use(authenticate);


// Every endpoint accepts ?range=today|week|month|year, or
// ?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD. Add &format=csv on the
// list-style reports to download a spreadsheet instead of JSON.
function parseRange(req: Request, res: Response, defaultRange: string): DateRange | null {
  try {
    return resolveDateRange(req.query, defaultRange);
  } catch {
    res.status(400).json({
      error: "Invalid date range. Use range=today|week|month|year, or range=custom with from and to (YYYY-MM-DD).",
    });
    return null;
  }
}

const wantsCsv = (req: Request) => req.query.format === "csv";
const day = (d: Date) => d.toISOString().slice(0, 10);
const periodOf = (r: DateRange) => ({ label: r.label, from: r.from, to: r.to });

// ---- GET /reports/dashboard ---- (default: today)
router.get("/dashboard", requirePermission("reports.view"), async (req, res) => {
  const range = parseRange(req, res, "today");
  if (!range) return;
  const businessId = req.auth!.businessId;

  const saleWhere = {
    businessId,
    status: "COMPLETED" as const,
    createdAt: { gte: range.from, lte: range.to },
  };

  const [salesAgg, byMethod, periodMovements, balanceMovements, lowStock, recentEntries] =
    await Promise.all([
      prisma.sale.aggregate({ where: saleWhere, _count: { _all: true }, _sum: { total: true } }),
      prisma.sale.groupBy({
        by: ["paymentMethod"],
        where: saleWhere,
        _count: { _all: true },
        _sum: { total: true },
      }),
      accountMovements(businessId, { from: range.from, to: range.to }),
      accountMovements(businessId, { to: range.to }),
      prisma.$queryRaw<any[]>`
        SELECT id, name, sku, "currentQuantity", "minStockLevel"
        FROM products
        WHERE "businessId" = ${businessId}
          AND "isActive" = true
          AND "currentQuantity" <= "minStockLevel"
        ORDER BY "currentQuantity" ASC
        LIMIT 10`,
      prisma.journalEntry.findMany({
        where: { businessId },
        orderBy: { createdAt: "desc" },
        take: 10,
        include: { lines: { include: { account: { select: { code: true } } } } },
      }),
    ]);

  const profit = summarizeProfit(periodMovements);

  return res.json({
    period: periodOf(range),
    sales: {
      orders: salesAgg._count._all,
      total: round2(Number(salesAgg._sum.total ?? 0)),
    },
    profit: {
      revenue: profit.revenue,
      costOfGoodsSold: profit.costOfGoodsSold,
      grossProfit: profit.grossProfit,
      expenses: profit.operatingExpenses,
      netProfit: profit.netProfit,
    },
    balances: {
      cash: balanceOf(balanceMovements, ACCOUNT_CODES.CASH),
      bank: balanceOf(balanceMovements, ACCOUNT_CODES.BANK),
      mobileMoney: balanceOf(balanceMovements, ACCOUNT_CODES.MOBILE_MONEY),
      paystackClearing: balanceOf(balanceMovements, ACCOUNT_CODES.PAYSTACK_CLEARING),
      accountsReceivable: balanceOf(balanceMovements, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE),
      accountsPayable: balanceOf(balanceMovements, ACCOUNT_CODES.ACCOUNTS_PAYABLE),
    },
    paymentMethods: byMethod.map((m) => ({
      method: m.paymentMethod,
      orders: m._count._all,
      total: round2(Number(m._sum.total ?? 0)),
    })),
    lowStock,
    recentTransactions: recentEntries.map((e) => {
      // A sale's entry also carries a cost-of-goods line, so summing every
      // debit would overstate it. For sales and their cancellations, show the
      // sales-revenue side — the amount the customer actually paid.
      const isSale = e.sourceType === "SALE" || e.sourceType === "SALE_CANCELLATION";
      const amount = isSale
        ? e.lines
            .filter((l) => l.account.code === ACCOUNT_CODES.SALES_REVENUE)
            .reduce((s, l) => s + Number(l.debit) + Number(l.credit), 0)
        : e.lines.reduce((s, l) => s + Number(l.debit), 0);
      return {
        date: e.entryDate,
        type: e.sourceType,
        description: e.description,
        amount: round2(amount),
      };
    }),
  });
});

// ---- GET /reports/profit-loss ---- (default: this month)
router.get("/profit-loss", requirePermission("reports.view"), async (req, res) => {
  const range = parseRange(req, res, "month");
  if (!range) return;

  const movements = await accountMovements(req.auth!.businessId, { from: range.from, to: range.to });
  const p = summarizeProfit(movements);
  const line = (m: { code: string; name: string; net: number }) => ({ code: m.code, name: m.name, amount: m.net });

  return res.json({
    period: periodOf(range),
    revenue: { lines: p.revenueLines.map(line), total: p.revenue },
    costOfGoodsSold: p.costOfGoodsSold,
    grossProfit: p.grossProfit,
    operatingExpenses: { lines: p.expenseLines.map(line), total: p.operatingExpenses },
    netProfit: p.netProfit,
  });
});

// ---- GET /reports/balances ---- money position + what's owed, as of the end of the range
router.get("/balances", requirePermission("reports.view"), async (req, res) => {
  const range = parseRange(req, res, "today");
  if (!range) return;
  const businessId = req.auth!.businessId;

  const [movements, unpaid] = await Promise.all([
    accountMovements(businessId, { to: range.to }),
    prisma.purchase.findMany({
      where: { businessId, paymentStatus: { not: "PAID" }, createdAt: { lte: range.to } },
      include: { supplier: { select: { id: true, name: true } } },
    }),
  ]);

  const owedBySupplier = new Map<string, { supplierId: string; supplier: string; outstanding: number }>();
  for (const p of unpaid) {
    const entry = owedBySupplier.get(p.supplierId) ?? { supplierId: p.supplierId, supplier: p.supplier.name, outstanding: 0 };
    entry.outstanding = round2(entry.outstanding + Number(p.totalCost) - Number(p.amountPaid));
    owedBySupplier.set(p.supplierId, entry);
  }
  const suppliers = [...owedBySupplier.values()];
  const owedFromPurchases = round2(suppliers.reduce((s, x) => s + x.outstanding, 0));
  const payableInLedger = balanceOf(movements, ACCOUNT_CODES.ACCOUNTS_PAYABLE);

  return res.json({
    asOf: range.to,
    cash: balanceOf(movements, ACCOUNT_CODES.CASH),
    bank: balanceOf(movements, ACCOUNT_CODES.BANK),
    mobileMoney: balanceOf(movements, ACCOUNT_CODES.MOBILE_MONEY),
    paystackClearing: balanceOf(movements, ACCOUNT_CODES.PAYSTACK_CLEARING),
    inventoryValue: balanceOf(movements, ACCOUNT_CODES.INVENTORY),
    accountsReceivable: balanceOf(movements, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE),
    accountsPayable: {
      ledgerBalance: payableInLedger,
      owedToSuppliers: owedFromPurchases,
      suppliers,
      // If these two differ, some purchase was recorded without its accounting
      // entry (e.g. before the finance module existed) — flagged, not hidden (rule #34).
      inSync: Math.abs(payableInLedger - owedFromPurchases) < 0.005,
    },
  });
});

// ---- GET /reports/sales ---- (default: this month)
router.get("/sales", requirePermission("reports.view"), async (req, res) => {
  const range = parseRange(req, res, "month");
  if (!range) return;

  const sales = await prisma.sale.findMany({
    where: { businessId: req.auth!.businessId, createdAt: { gte: range.from, lte: range.to } },
    include: { cashier: { select: { name: true } }, customer: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  if (wantsCsv(req)) {
    return sendCsv(
      res,
      `sales-${day(range.from)}-to-${day(range.to)}.csv`,
      sales.map((s) => ({
        receiptNumber: s.receiptNumber,
        date: s.createdAt,
        cashier: s.cashier.name,
        customer: s.customer?.name ?? "",
        paymentMethod: s.paymentMethod,
        paymentStatus: s.paymentStatus,
        status: s.status,
        subtotal: Number(s.subtotal),
        discount: Number(s.discountTotal),
        total: Number(s.total),
      }))
    );
  }

  const completed = sales.filter((s) => s.status === "COMPLETED");
  const byDay = new Map<string, { date: string; orders: number; total: number }>();
  for (const s of completed) {
    const key = day(s.createdAt);
    const row = byDay.get(key) ?? { date: key, orders: 0, total: 0 };
    row.orders += 1;
    row.total = round2(row.total + Number(s.total));
    byDay.set(key, row);
  }

  return res.json({
    period: periodOf(range),
    summary: {
      orders: completed.length,
      subtotal: round2(completed.reduce((t, s) => t + Number(s.subtotal), 0)),
      discounts: round2(completed.reduce((t, s) => t + Number(s.discountTotal), 0)),
      total: round2(completed.reduce((t, s) => t + Number(s.total), 0)),
      cancelled: sales.length - completed.length,
    },
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    sales: sales.slice(0, 200),
  });
});

// ---- GET /reports/product-sales ---- best sellers with profit per product (default: this month)
router.get("/product-sales", requirePermission("reports.view"), async (req, res) => {
  const range = parseRange(req, res, "month");
  if (!range) return;

  const rows = await prisma.$queryRaw<any[]>`
    SELECT si."productId", si."productName",
           SUM(si.quantity)::int AS "quantitySold",
           SUM(si."lineTotal") AS revenue,
           SUM(si."unitCost" * si.quantity) AS cost
    FROM sale_items si
    JOIN sales s ON s.id = si."saleId"
    WHERE s."businessId" = ${req.auth!.businessId}
      AND s.status = 'COMPLETED'
      AND s."createdAt" >= ${range.from}
      AND s."createdAt" <= ${range.to}
    GROUP BY si."productId", si."productName"
    ORDER BY revenue DESC`;

  const products = rows.map((r) => {
    const revenue = round2(Number(r.revenue));
    const cost = round2(Number(r.cost));
    return {
      productId: r.productId,
      productName: r.productName,
      quantitySold: r.quantitySold,
      revenue,
      cost,
      profit: round2(revenue - cost),
    };
  });

  if (wantsCsv(req)) {
    return sendCsv(res, `product-sales-${day(range.from)}-to-${day(range.to)}.csv`, products);
  }
  return res.json({ period: periodOf(range), products });
});

// ---- GET /reports/inventory ---- current stock and its value (a snapshot, no date range)
router.get("/inventory", requirePermission("reports.stock"), async (req, res) => {
  const products = await prisma.product.findMany({
    where: { businessId: req.auth!.businessId, isActive: true },
    include: { category: { select: { name: true } } },
    orderBy: { name: "asc" },
  });

  const rows = products.map((p) => ({
    name: p.name,
    sku: p.sku ?? "",
    category: p.category?.name ?? "",
    quantity: p.currentQuantity,
    minStockLevel: p.minStockLevel,
    lowStock: p.currentQuantity <= p.minStockLevel,
    costPrice: Number(p.costPrice),
    sellingPrice: Number(p.sellingPrice),
    stockValueAtCost: round2(p.currentQuantity * Number(p.costPrice)),
    stockValueAtSelling: round2(p.currentQuantity * Number(p.sellingPrice)),
  }));

  if (wantsCsv(req)) return sendCsv(res, `inventory-${day(new Date())}.csv`, rows);

  return res.json({
    products: rows,
    totals: {
      products: rows.length,
      lowStock: rows.filter((r) => r.lowStock).length,
      stockValueAtCost: round2(rows.reduce((s, r) => s + r.stockValueAtCost, 0)),
      stockValueAtSelling: round2(rows.reduce((s, r) => s + r.stockValueAtSelling, 0)),
    },
  });
});

// ---- GET /reports/purchases ---- (default: this month)
router.get("/purchases", requirePermission("reports.stock"), async (req, res) => {
  const range = parseRange(req, res, "month");
  if (!range) return;

  const purchases = await prisma.purchase.findMany({
    where: { businessId: req.auth!.businessId, createdAt: { gte: range.from, lte: range.to } },
    include: { supplier: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  const rows = purchases.map((p) => ({
    date: p.createdAt,
    supplier: p.supplier.name,
    total: Number(p.totalCost),
    paid: Number(p.amountPaid),
    outstanding: round2(Number(p.totalCost) - Number(p.amountPaid)),
    paymentStatus: p.paymentStatus,
  }));

  if (wantsCsv(req)) return sendCsv(res, `purchases-${day(range.from)}-to-${day(range.to)}.csv`, rows);

  return res.json({
    period: periodOf(range),
    totals: {
      purchases: rows.length,
      total: round2(rows.reduce((s, r) => s + r.total, 0)),
      paid: round2(rows.reduce((s, r) => s + r.paid, 0)),
      outstanding: round2(rows.reduce((s, r) => s + r.outstanding, 0)),
    },
    purchases: rows.slice(0, 200),
  });
});

// ---- GET /reports/expenses ---- (default: this month)
router.get("/expenses", requirePermission("reports.view"), async (req, res) => {
  const range = parseRange(req, res, "month");
  if (!range) return;

  const expenses = await prisma.expense.findMany({
    where: { businessId: req.auth!.businessId, createdAt: { gte: range.from, lte: range.to } },
    include: {
      categoryAccount: { select: { name: true } },
      paymentAccount: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  const rows = expenses.map((e) => ({
    date: e.createdAt,
    category: e.categoryAccount.name,
    amount: Number(e.amount),
    paidFrom: e.paymentAccount.name,
    description: e.description ?? "",
    reference: e.reference ?? "",
  }));

  if (wantsCsv(req)) return sendCsv(res, `expenses-${day(range.from)}-to-${day(range.to)}.csv`, rows);

  const byCategory = new Map<string, number>();
  for (const r of rows) byCategory.set(r.category, round2((byCategory.get(r.category) ?? 0) + r.amount));

  return res.json({
    period: periodOf(range),
    total: round2(rows.reduce((s, r) => s + r.amount, 0)),
    byCategory: [...byCategory.entries()]
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total),
    expenses: rows.slice(0, 200),
  });
});

// ---- GET /reports/payments ---- how customers paid, and how each payment ended up (default: this month)
router.get("/payments", requirePermission("reports.view"), async (req, res) => {
  const range = parseRange(req, res, "month");
  if (!range) return;

  const grouped = await prisma.sale.groupBy({
    by: ["paymentMethod", "paymentStatus"],
    where: { businessId: req.auth!.businessId, createdAt: { gte: range.from, lte: range.to } },
    _count: { _all: true },
    _sum: { total: true },
  });

  const rows = grouped.map((g) => ({
    paymentMethod: g.paymentMethod,
    paymentStatus: g.paymentStatus,
    orders: g._count._all,
    total: round2(Number(g._sum.total ?? 0)),
  }));

  if (wantsCsv(req)) return sendCsv(res, `payments-${day(range.from)}-to-${day(range.to)}.csv`, rows);
  return res.json({ period: periodOf(range), payments: rows });
});

export default router;
