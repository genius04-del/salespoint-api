import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { wasDeducted, pendingFrom, inPendingDeduction } from "../../services/stockDeduction";

const db = vi.hoisted(() => ({
  dayEnd: true,
  start: new Date("2026-11-01T00:00:00Z") as Date | null,
  deductions: [] as any[],
  sales: [] as any[],
  ingredients: [] as any[],
  products: [] as any[],
  recipeLines: [] as any[],
  movements: [] as any[],
  counter: 0,
  openTabs: 0,
}));

vi.mock("../../config/prisma", () => {
  const prisma: any = {
    $queryRaw: async () => [],
    $transaction: async (fn: any) => fn(prisma),
    business: {
      findUnique: async () => ({ deductStockAtDayEnd: db.dayEnd, stockDeductionStart: db.start }),
      update: async () => ({ deductionCounter: ++db.counter }),
    },
    stockDeduction: {
      findFirst: async (args: any) => {
        const w = args?.where ?? {};
        if (w.number !== undefined) return db.deductions.find((d) => d.number === w.number) ?? null;
        if (w.id !== undefined) return db.deductions.find((d) => d.id === w.id) ?? null;
        return [...db.deductions].sort((a, b) => +b.toAt - +a.toAt)[0] ?? null;
      },
      findMany: async () => db.deductions,
      create: async ({ data }: any) => { const d = { id: `sd${db.deductions.length + 1}`, ...data }; db.deductions.push(d); return d; },
      update: async ({ where, data }: any) => Object.assign(db.deductions.find((d) => d.id === where.id), data),
      delete: async ({ where }: any) => void (db.deductions = db.deductions.filter((d) => d.id !== where.id)),
    },
    sale: {
      findMany: async ({ where }: any) => db.sales.filter((s) => s.status === "COMPLETED" && s.createdAt > where.createdAt.gt && s.createdAt <= where.createdAt.lte),
      count: async ({ where }: any) => db.sales.filter((s) => s.status === "COMPLETED" && s.createdAt > where.createdAt.gt && s.createdAt <= where.createdAt.lte).length,
    },
    product: {
      findMany: async ({ where }: any) => db.products.filter((p) => where.id.in.includes(p.id)),
      findFirst: async ({ where }: any) => db.products.find((p) => p.id === where.id) ?? null,
      update: async ({ where, data }: any) => Object.assign(db.products.find((p) => p.id === where.id), data),
    },
    recipeLine: {
      findMany: async ({ where }: any) =>
        db.recipeLines.filter((l) => where.productId.in.includes(l.productId)).map((l) => ({ ...l, ingredient: db.ingredients.find((i) => i.id === l.ingredientId) })),
    },
    ingredient: {
      findFirst: async ({ where }: any) => db.ingredients.find((i) => i.id === where.id) ?? null,
      update: async ({ where, data }: any) => Object.assign(db.ingredients.find((i) => i.id === where.id), data),
    },
    ingredientMovement: { create: async ({ data }: any) => void db.movements.push({ kind: "ING", ...data }) },
    inventoryMovement: { create: async ({ data }: any) => { db.movements.push({ kind: "PROD", ...data }); return data; } },
    order: { count: async () => db.openTabs },
    user: { findMany: async () => [{ id: "u1", name: "Ama" }] },
    auditLog: { create: async () => ({}) },
  };
  return { prisma };
});
vi.mock("@prisma/client", async () => {
  const { Decimal } = await import("@prisma/client/runtime/library");
  return { Prisma: { Decimal } };
});
vi.mock("../../middleware/auth", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.auth = { userId: "u1", businessId: "b1", role: "MANAGER", permissions: String(req.headers["x-perms"] ?? "stock.manage").split(",") };
    next();
  },
  requirePermission: (...required: string[]) => (req: any, res: any, next: any) =>
    required.some((p) => req.auth.permissions.includes(p)) ? next() : res.status(403).json({ error: "perm" }),
}));

import routes from "../stockDeductions";
const app = express();
app.use(express.json());
app.use("/stock-deductions", routes);

const sale = (at: string, items: [string, number][], status = "COMPLETED") => ({ status, createdAt: new Date(at), items: items.map(([productId, quantity]) => ({ productId, quantity })) });

beforeEach(() => {
  Object.assign(db, { dayEnd: true, start: new Date("2026-11-01T00:00:00Z"), deductions: [], sales: [], movements: [], counter: 0, openTabs: 0 });
  db.ingredients = [
    { id: "pep", name: "Pepperoni", unit: "g", currentQuantity: 1000 },
    { id: "cheese", name: "Cheese", unit: "g", currentQuantity: 5000 },
  ];
  db.products = [
    { id: "med", name: "Medium Pizza", unit: "unit", currentQuantity: 0 },
    { id: "cola", name: "Cola", unit: "bottle", currentQuantity: 24 },
  ];
  db.recipeLines = [
    { productId: "med", ingredientId: "pep", quantity: 50 },
    { productId: "med", ingredientId: "cheese", quantity: 200 },
  ];
});

const lineBody = (r: any) => r.body.deduction.lines.map((l: any) => ({ kind: l.kind, id: l.id, quantity: l.quantity }));
const pep = () => Number(db.ingredients.find((i) => i.id === "pep").currentQuantity);

describe("deducting the day's sales from stock", () => {
  it("previews the theoretical closing: 10 medium pizzas use 500g of 1kg pepperoni, leaving 500g", async () => {
    db.sales = [sale("2026-11-03T10:00:00Z", [["med", 6], ["cola", 2]]), sale("2026-11-03T12:00:00Z", [["med", 4]])];
    const res = await request(app).get("/stock-deductions/preview");
    expect(res.status).toBe(200);
    expect(res.body.lines.find((l: any) => l.id === "pep")).toMatchObject({ quantity: 500, before: 1000, after: 500 });
    expect(res.body.lines.find((l: any) => l.id === "cheese")).toMatchObject({ quantity: 2000, after: 3000 });
    expect(res.body.lines.find((l: any) => l.id === "cola")).toMatchObject({ kind: "PRODUCT", quantity: 2, after: 22 });
    expect(res.body.salesCount).toBe(2);
    expect(pep()).toBe(1000);
  });

  it("creating the deduction only freezes it: stock is not touched until the file is uploaded", async () => {
    db.sales = [sale("2026-11-03T10:00:00Z", [["med", 10]])];
    const made = await request(app).post("/stock-deductions");
    expect(made.status).toBe(201);
    expect(made.body.deduction).toMatchObject({ number: 1, status: "PENDING", salesCount: 1 });
    expect(pep()).toBe(1000);
    expect(db.movements).toHaveLength(0);
  });

  it("uploading the file takes the usage off stock, once", async () => {
    db.sales = [sale("2026-11-03T10:00:00Z", [["med", 10]])];
    const made = await request(app).post("/stock-deductions");
    const applied = await request(app).post("/stock-deductions/apply").send({ number: 1, lines: lineBody(made) });
    expect(applied.status).toBe(200);
    expect(pep()).toBe(500);
    expect(db.movements.filter((m) => m.kind === "ING").every((m) => m.type === "SALE_USAGE")).toBe(true);
    expect(db.deductions[0].status).toBe("APPLIED");
    const again = await request(app).post("/stock-deductions/apply").send({ number: 1, lines: lineBody(made) });
    expect(again.status).toBe(409);
    expect(pep()).toBe(500);
  });

  it("refuses a file that was changed, or that belongs to another deduction", async () => {
    db.sales = [sale("2026-11-03T10:00:00Z", [["med", 10]])];
    const made = await request(app).post("/stock-deductions");
    const tampered = lineBody(made).map((l: any) => (l.id === "pep" ? { ...l, quantity: 50 } : l));
    const bad = await request(app).post("/stock-deductions/apply").send({ number: 1, lines: tampered });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("FILE_MISMATCH");
    expect(pep()).toBe(1000);
    expect((await request(app).post("/stock-deductions/apply").send({ number: 7, lines: lineBody(made) })).status).toBe(404);
  });

  it("will not make a second deduction while one is waiting, and cancelling frees its sales", async () => {
    db.sales = [sale("2026-11-03T10:00:00Z", [["med", 10]])];
    const made = await request(app).post("/stock-deductions");
    expect((await request(app).post("/stock-deductions")).status).toBe(409);
    expect((await request(app).delete(`/stock-deductions/${made.body.deduction.id}`)).status).toBe(200);
    expect((await request(app).post("/stock-deductions")).status).toBe(201);
  });

  it("an applied deduction cannot be removed", async () => {
    db.sales = [sale("2026-11-03T10:00:00Z", [["med", 10]])];
    const made = await request(app).post("/stock-deductions");
    await request(app).post("/stock-deductions/apply").send({ number: 1, lines: lineBody(made) });
    expect((await request(app).delete(`/stock-deductions/${made.body.deduction.id}`)).status).toBe(409);
  });

  it("only takes sales made since the last run", async () => {
    db.counter = 1;
    db.deductions = [{ id: "sd0", number: 1, status: "APPLIED", fromAt: new Date("2026-11-01T00:00:00Z"), toAt: new Date("2026-11-03T20:00:00Z"), createdById: "u1" }];
    db.sales = [sale("2026-11-03T10:00:00Z", [["med", 10]]), sale("2026-11-04T12:00:00Z", [["med", 2]])];
    const made = await request(app).post("/stock-deductions");
    expect(made.status).toBe(201);
    expect(made.body.deduction.salesCount).toBe(1);
    await request(app).post("/stock-deductions/apply").send({ number: 2, lines: lineBody(made) });
    expect(pep()).toBe(900);
  });

  it("ignores cancelled sales and sales from before day-end mode was switched on", async () => {
    db.sales = [sale("2026-10-20T10:00:00Z", [["med", 50]]), sale("2026-11-03T10:00:00Z", [["med", 5]], "CANCELLED")];
    expect((await request(app).get("/stock-deductions/preview")).body.salesCount).toBe(0);
    expect((await request(app).post("/stock-deductions")).status).toBe(409);
  });

  it("selling more than the stock allows still deducts, going negative so the count shows it", async () => {
    db.ingredients[0].currentQuantity = 200;
    db.sales = [sale("2026-11-03T10:00:00Z", [["med", 10]])];
    const made = await request(app).post("/stock-deductions");
    await request(app).post("/stock-deductions/apply").send({ number: 1, lines: lineBody(made) });
    expect(pep()).toBe(-300);
  });

  it("does nothing when the business deducts as it sells", async () => {
    db.dayEnd = false;
    expect((await request(app).get("/stock-deductions/preview")).body.enabled).toBe(false);
    expect((await request(app).post("/stock-deductions")).status).toBe(409);
  });

  it("applying needs stock permission; making the file can also be done by day.close", async () => {
    db.sales = [sale("2026-11-03T10:00:00Z", [["med", 1]])];
    expect((await request(app).get("/stock-deductions/preview").set("x-perms", "sales.create")).status).toBe(403);
    expect((await request(app).post("/stock-deductions").set("x-perms", "day.close")).status).toBe(201);
    expect((await request(app).post("/stock-deductions/apply").set("x-perms", "day.close").send({ number: 1, lines: [{ kind: "PRODUCT", id: "x", quantity: 1 }] })).status).toBe(403);
  });
});

describe("deciding if stock was already taken off", () => {
  const d = (x: string) => new Date(`${x}T00:00:00Z`);
  const state = { dayEnd: true, start: d("2026-11-01"), lastTo: d("2026-11-05"), appliedTo: d("2026-11-05"), pending: null as any };
  it("a business that deducts as it sells always has", () => {
    expect(wasDeducted({ dayEnd: false, start: null, lastTo: null, appliedTo: null, pending: null }, new Date())).toBe(true);
  });
  it("sales before the switch, or covered by a saved run, were deducted; later ones were not", () => {
    expect(wasDeducted(state, d("2026-10-30"))).toBe(true);
    expect(wasDeducted(state, d("2026-11-03"))).toBe(true);
    expect(wasDeducted(state, d("2026-11-06"))).toBe(false);
  });
  it("sales in a run still waiting to be uploaded were not deducted, and cannot be cancelled yet", () => {
    const waiting = { ...state, lastTo: d("2026-11-07"), appliedTo: d("2026-11-05"), pending: { id: "p", number: 2, fromAt: d("2026-11-05"), toAt: d("2026-11-07") } };
    expect(wasDeducted(waiting, d("2026-11-06"))).toBe(false);
    expect(inPendingDeduction(waiting, d("2026-11-06"))).toBe(true);
    expect(inPendingDeduction(waiting, d("2026-11-04"))).toBe(false);
    expect(pendingFrom(waiting)).toEqual(waiting.lastTo);
  });
  it("new sales start from the last run, or the switch-on", () => {
    expect(pendingFrom(state)).toEqual(state.lastTo);
    expect(pendingFrom({ ...state, lastTo: null })).toEqual(state.start);
  });
});
