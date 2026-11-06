import { Prisma } from "@prisma/client";
import { applyProductStock } from "./productStock";

type Db = Prisma.TransactionClient;

// Restaurants can choose that SELLING does not touch stock. The manager deducts
// the day's sales from stock afterwards, which gives the theoretical closing
// stock to compare with the count.
export interface PendingDeduction {
  id: string;
  number: number;
  fromAt: Date;
  toAt: Date;
}

export interface DeductionState {
  dayEnd: boolean; // true = stock is deducted by a manager run, not at sale time
  start: Date | null; // sales before this were deducted as they happened
  lastTo: Date | null; // the latest run (applied or not) covered sales up to here
  appliedTo: Date | null; // stock has really been taken off for sales up to here
  pending: PendingDeduction | null; // a run waiting to be uploaded in Stock Adjustment
}

export async function getDeductionState(db: Db, businessId: string): Promise<DeductionState> {
  const [business, last] = await Promise.all([
    db.business.findUnique({ where: { id: businessId }, select: { deductStockAtDayEnd: true, stockDeductionStart: true } }),
    db.stockDeduction.findFirst({ where: { businessId }, orderBy: { toAt: "desc" }, select: { id: true, number: true, status: true, fromAt: true, toAt: true } }),
  ]);
  // Runs are strictly one after another, so only the latest can be waiting.
  const pending = last && last.status === "PENDING" ? { id: last.id, number: last.number, fromAt: last.fromAt, toAt: last.toAt } : null;
  return {
    dayEnd: !!business?.deductStockAtDayEnd,
    start: business?.stockDeductionStart ?? null,
    lastTo: last?.toAt ?? null,
    appliedTo: last ? (pending ? last.fromAt : last.toAt) : null,
    pending,
  };
}

// Has stock already been taken off for something created at this moment?
// Used when cancelling: only put stock back if it was actually taken.
export function wasDeducted(state: DeductionState, createdAt: Date): boolean {
  if (!state.dayEnd) return true;
  if (state.start && createdAt < state.start) return true;
  if (state.appliedTo && createdAt <= state.appliedTo) return true;
  return false;
}

// A sale inside a run that is still waiting to be uploaded: cancelling it now would
// leave the file out of step with the books.
export function inPendingDeduction(state: DeductionState, createdAt: Date): boolean {
  return !!state.pending && createdAt > state.pending.fromAt && createdAt <= state.pending.toAt;
}

// The point from which sales still wait to be deducted.
export const pendingFrom = (state: DeductionState): Date => state.lastTo ?? state.start ?? new Date(0);

export async function countPendingSales(db: Db, businessId: string, state: DeductionState, to = new Date()) {
  return db.sale.count({ where: { businessId, status: "COMPLETED", createdAt: { gt: pendingFrom(state), lte: to } } });
}

export interface UsageLine {
  kind: "INGREDIENT" | "PRODUCT";
  id: string;
  name: string;
  unit: string;
  quantity: number; // how much the sales used
  before: number; // system quantity now
  after: number; // theoretical closing
  soldAs?: string[]; // menu items that used it, for the screen
}

// What the sales between from and to consumed: recipe dishes use their
// ingredients; items without a recipe use their own stock.
export async function computeUsage(db: Db, businessId: string, from: Date, to: Date) {
  const sales = await db.sale.findMany({
    where: { businessId, status: "COMPLETED", createdAt: { gt: from, lte: to } },
    select: { items: { select: { productId: true, quantity: true } } },
  });
  const sold = new Map<string, number>();
  for (const s of sales as any[]) for (const i of s.items) sold.set(i.productId, (sold.get(i.productId) ?? 0) + i.quantity);

  const productIds = [...sold.keys()];
  const [products, recipeLines] = productIds.length
    ? await Promise.all([
        db.product.findMany({ where: { id: { in: productIds }, businessId }, select: { id: true, name: true, unit: true, currentQuantity: true } }),
        db.recipeLine.findMany({ where: { productId: { in: productIds } }, include: { ingredient: true } }),
      ])
    : [[], []];

  const productById = new Map<string, any>((products as any[]).map((p) => [p.id, p]));
  const withRecipe = new Set<string>((recipeLines as any[]).map((l) => l.productId));

  const lines = new Map<string, UsageLine>();
  const add = (key: string, base: Omit<UsageLine, "quantity" | "after" | "soldAs">, qty: number, dish: string) => {
    const existing = lines.get(key) ?? { ...base, quantity: 0, after: 0, soldAs: [] as string[] };
    existing.quantity = Math.round((existing.quantity + qty) * 1e6) / 1e6;
    if (!existing.soldAs!.includes(dish)) existing.soldAs!.push(dish);
    lines.set(key, existing);
  };

  for (const l of recipeLines as any[]) {
    const units = sold.get(l.productId) ?? 0;
    const dish = productById.get(l.productId)?.name ?? "Item";
    add(`I:${l.ingredientId}`, { kind: "INGREDIENT", id: l.ingredientId, name: l.ingredient.name, unit: l.ingredient.unit, before: Number(l.ingredient.currentQuantity) }, Number(l.quantity) * units, dish);
  }
  for (const [productId, units] of sold) {
    if (withRecipe.has(productId)) continue;
    const p = productById.get(productId);
    if (!p) continue;
    add(`P:${productId}`, { kind: "PRODUCT", id: productId, name: p.name, unit: p.unit, before: Number(p.currentQuantity) }, units, p.name);
  }

  const out = [...lines.values()].map((l) => ({ ...l, after: Math.round((l.before - l.quantity) * 1e6) / 1e6 }));
  out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return { salesCount: (sales as any[]).length, sold: productIds.length, lines: out };
}

// Takes the usage off stock. One movement per ingredient/item, never blocked by
// low stock (the count will show any gap).
export async function applyUsage(params: { tx: Db; businessId: string; userId: string; lines: UsageLine[]; reason: string; reference: string }) {
  const { tx, businessId, userId, reason, reference } = params;
  for (const l of params.lines) {
    if (l.quantity <= 0) continue;
    if (l.kind === "INGREDIENT") {
      const { applyIngredientMovement } = await import("./ingredientStock");
      await applyIngredientMovement({ tx, businessId, ingredientId: l.id, type: "SALE_USAGE", quantityChange: -l.quantity, reason, reference, userId, allowNegative: true });
    } else {
      await applyProductStock({ tx, businessId, productId: l.id, type: "SALE", quantityChange: -l.quantity, reason, reference, userId, allowNegativeStock: true });
    }
  }
}
