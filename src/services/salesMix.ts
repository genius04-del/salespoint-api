// Pure aggregation for the Sales Mix report — no database, unit-tested.

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface SalesMixRow {
  productId: string;
  productName: string;
  categoryName: string | null;
  quantity: number;
  lineTotal: number; // what the customer paid for this line (after discount)
  unitCost: number;
}

export interface MixProduct {
  productId: string;
  productName: string;
  category: string;
  quantity: number;
  revenue: number;
  cost: number;
  profit: number;
  quantitySharePct: number;
  revenueSharePct: number;
}

export interface MixCategory {
  category: string;
  quantity: number;
  revenue: number;
  revenueSharePct: number;
}

const pct = (part: number, whole: number) => (whole > 0 ? round2((part / whole) * 100) : 0);

export function buildSalesMix(rows: SalesMixRow[]) {
  const byProduct = new Map<string, MixProduct>();

  for (const r of rows) {
    const key = r.productId;
    let p = byProduct.get(key);
    if (!p) {
      p = {
        productId: r.productId,
        productName: r.productName,
        category: r.categoryName ?? "Uncategorised",
        quantity: 0,
        revenue: 0,
        cost: 0,
        profit: 0,
        quantitySharePct: 0,
        revenueSharePct: 0,
      };
      byProduct.set(key, p);
    }
    p.quantity += r.quantity;
    p.revenue += r.lineTotal;
    p.cost += r.unitCost * r.quantity;
  }

  const products = [...byProduct.values()];
  const totalQty = products.reduce((s, p) => s + p.quantity, 0);
  const totalRevenue = products.reduce((s, p) => s + p.revenue, 0);
  const totalCost = products.reduce((s, p) => s + p.cost, 0);

  for (const p of products) {
    p.revenue = round2(p.revenue);
    p.cost = round2(p.cost);
    p.profit = round2(p.revenue - p.cost);
    p.quantitySharePct = pct(p.quantity, totalQty);
    p.revenueSharePct = pct(p.revenue, totalRevenue);
  }
  products.sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue || a.productName.localeCompare(b.productName));

  const byCategory = new Map<string, MixCategory>();
  for (const p of products) {
    const c = byCategory.get(p.category) ?? { category: p.category, quantity: 0, revenue: 0, revenueSharePct: 0 };
    c.quantity += p.quantity;
    c.revenue = round2(c.revenue + p.revenue);
    byCategory.set(p.category, c);
  }
  const categories = [...byCategory.values()];
  for (const c of categories) c.revenueSharePct = pct(c.revenue, totalRevenue);
  categories.sort((a, b) => b.revenue - a.revenue);

  return {
    totals: {
      itemsSold: totalQty,
      revenue: round2(totalRevenue),
      cost: round2(totalCost),
      profit: round2(totalRevenue - totalCost),
      distinctProducts: products.length,
    },
    products,
    categories,
  };
}
