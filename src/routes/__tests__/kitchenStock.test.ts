import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---- Tiny in-memory stand-in for Prisma (no database needed) ---------------
const db = vi.hoisted(() => {
  const t: Record<string, any[]> = {};
  let n = 0;
  const table = (name: string) => (t[name] ??= []);
  const matches = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (k === "NOT") return true;
      if (v && typeof v === "object" && !(v instanceof Date) && "in" in v) return v.in.includes(row[k]);
      if (v && typeof v === "object" && "none" in v) return true;
      if (v && typeof v === "object" && !(v instanceof Date) && !("toFixed" in v) && !("d" in v)) return true; // relation/range filters: not modelled
      return row[k] === v;
    });
  const model = (name: string, defaults: () => any = () => ({})) => ({
    findFirst: async ({ where }: any = {}) => table(name).find((r) => matches(r, where)) ?? null,
    findFirstOrThrow: async ({ where }: any = {}) => table(name).find((r) => matches(r, where)),
    findMany: async ({ where }: any = {}) => table(name).filter((r) => matches(r, where)),
    create: async ({ data }: any) => {
      const { lines, ...rest } = data;
      const row = { id: `${name}${++n}`, createdAt: new Date(), ...defaults(), ...rest };
      table(name).push(row);
      if (lines?.create) for (const l of lines.create) table(`${name}Line`).push({ id: `l${++n}`, countId: row.id, counted: null, variance: null, varianceValue: null, ...l });
      return row;
    },
    createMany: async ({ data }: any) => void table(name).push(...data.map((d: any) => ({ id: `${name}${++n}`, ...d }))),
    update: async ({ where, data }: any) => {
      const row = table(name).find((r) => matches(r, where))!;
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      const rows = table(name).filter((r) => matches(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
    delete: async ({ where }: any) => void (t[name] = table(name).filter((r) => r.id !== where.id)),
    deleteMany: async ({ where }: any) => void (t[name] = table(name).filter((r) => !matches(r, where))),
  });
  const counter = { journalNo: 0 };
  return { t, table, model, counter, reset: () => { counter.journalNo = 0; for (const k of Object.keys(t)) t[k] = []; } };
});

vi.mock("../../config/prisma", () => {
  const stockCount = db.model("stockCount", () => ({ status: "DRAFT" }));
  const base = stockCount.findFirst;
  (stockCount as any).findFirst = async (args: any) => {
    const row = await base(args);
    return row ? { ...row, lines: db.table("stockCountLine").filter((l) => l.countId === row.id) } : null;
  };
  const prisma: any = {
    $transaction: async (fn: any) => fn(prisma),
    business: {
      findUnique: async () => ({ restaurantModeEnabled: true }),
      // The journal-number counter: bumped on every run.
      update: async () => ({ productionCounter: ++db.counter.journalNo }),
    },
    stockDeduction: { findFirst: async () => null },
    stockCount,
    stockCountLine: db.model("stockCountLine"),
    product: db.model("product"),
    ingredient: Object.assign(db.model("ingredient"), {}),
    ingredientMovement: db.model("ingredientMovement"),
    inventoryMovement: db.model("inventoryMovement"),
    recipeLine: db.model("recipeLine"),
    prepComponent: db.model("prepComponent"),
    productionBatch: db.model("productionBatch"),
    productionBatchLine: db.model("productionBatchLine"),
    user: db.model("user"),
    account: db.model("account"),
    journalEntry: {
      create: async ({ data }: any) => {
        const e = { id: `je${db.table("journal").length + 1}`, ...data, lines: data.lines.create };
        db.table("journal").push(e);
        return e;
      },
    },
    auditLog: { create: async () => ({}) },
  };
  // A prepared ingredient loads its components with it.
  const ingFind = prisma.ingredient.findFirst;
  prisma.ingredient.findFirst = async (args: any) => {
    const row = await ingFind(args);
    if (!row) return row;
    const components = db.table("prepComponent").filter((c) => c.outputId === row.id)
      .map((c) => ({ ...c, component: db.table("ingredient").find((i) => i.id === c.componentId) }));
    return { ...row, components };
  };
  return { prisma };
});

vi.mock("@prisma/client", async () => {
  const { Decimal } = await import("@prisma/client/runtime/library");
  return { Prisma: { Decimal } };
});

vi.mock("../../middleware/auth", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.auth = {
      userId: "u1", businessId: "b1", role: "MANAGER",
      permissions: String(req.headers["x-perms"] ?? "").split(",").filter(Boolean),
    };
    next();
  },
  requirePermission: (...required: string[]) => (req: any, res: any, next: any) =>
    required.some((p) => req.auth.permissions.includes(p)) ? next() : res.status(403).json({ error: "perm" }),
}));

import stockCountRoutes from "../stockCounts";
import productionRoutes from "../production";

const app = express();
app.use(express.json());
app.use("/stock-counts", stockCountRoutes);
app.use("/production", productionRoutes);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message ?? err) }));

const COUNTER = { "x-perms": "stock.view,stock.count" };
const BOSS = { "x-perms": "stock.view,stock.count,stock.approve" };
const COOK = { "x-perms": "stock.view,stock.produce" };

beforeEach(() => {
  db.reset();
  db.table("ingredient").push(
    { id: "cheese", businessId: "b1", name: "Cheese", unit: "kg", isPrepared: false, isActive: true, currentQuantity: "10", costPerUnit: "40" },
    { id: "flour", businessId: "b1", name: "Flour", unit: "kg", isPrepared: false, isActive: true, currentQuantity: "10", costPerUnit: "10" },
    { id: "dough", businessId: "b1", name: "Dough ball - Medium", unit: "piece", isPrepared: true, isActive: true, currentQuantity: "0", costPerUnit: "0" }
  );
  db.table("prepComponent").push({ id: "pc1", outputId: "dough", componentId: "flour", quantity: "0.15" });
  db.table("product").push({ id: "water", businessId: "b1", name: "Water", unit: "bottle", isActive: true, currentQuantity: 20, costPrice: "2" });
  db.table("account").push({ id: "a1040", businessId: "b1", code: "1040" });
});

describe("daily stock count", () => {
  async function startAndFill() {
    const start = await request(app).post("/stock-counts").set(COUNTER).send({});
    const lines = db.table("stockCountLine");
    const line = (name: string) => lines.find((l) => l.itemName === name)!;
    await request(app).put(`/stock-counts/${start.body.count.id}/lines`).set(COUNTER).send({
      lines: [
        { lineId: line("Cheese").id, counted: 8.5 },
        { lineId: line("Water").id, counted: 19 },
        { lineId: line("Flour").id, counted: 10 },
      ],
    });
    return start.body.count.id as string;
  }

  it("snapshots expected stock for products and ingredients, and allows only one open count", async () => {
    const first = await request(app).post("/stock-counts").set(COUNTER).send({});
    expect(first.status).toBe(201);
    expect(db.table("stockCountLine").map((l) => l.itemName).sort()).toEqual(["Cheese", "Dough ball - Medium", "Flour", "Water"]);
    const second = await request(app).post("/stock-counts").set(COUNTER).send({});
    expect(second.status).toBe(409);
  });

  it("works out variance per line as counted minus expected", async () => {
    await startAndFill();
    const cheese = db.table("stockCountLine").find((l) => l.itemName === "Cheese")!;
    expect(Number(cheese.variance)).toBe(-1.5);
    expect(Number(cheese.varianceValue)).toBe(-60);
  });

  it("refuses whole-unit violations for products", async () => {
    const start = await request(app).post("/stock-counts").set(COUNTER).send({});
    const water = db.table("stockCountLine").find((l) => l.itemName === "Water")!;
    const res = await request(app).put(`/stock-counts/${start.body.count.id}/lines`).set(COUNTER)
      .send({ lines: [{ lineId: water.id, counted: 19.5 }] });
    expect(res.status).toBe(400);
  });

  it("cannot be submitted empty", async () => {
    const start = await request(app).post("/stock-counts").set(COUNTER).send({});
    const res = await request(app).post(`/stock-counts/${start.body.count.id}/submit`).set(COUNTER);
    expect(res.status).toBe(400);
  });

  it("changes no stock until a manager approves, then adjusts stock and books the loss", async () => {
    const id = await startAndFill();
    await request(app).post(`/stock-counts/${id}/submit`).set(COUNTER);

    expect(db.table("ingredient").find((i) => i.id === "cheese")!.currentQuantity).toBe("10");

    const denied = await request(app).post(`/stock-counts/${id}/approve`).set(COUNTER);
    expect(denied.status).toBe(403);

    const ok = await request(app).post(`/stock-counts/${id}/approve`).set(BOSS);
    expect(ok.status).toBe(200);
    expect(String(db.table("ingredient").find((i) => i.id === "cheese")!.currentQuantity)).toBe("8.5");
    expect(db.table("product").find((p) => p.id === "water")!.currentQuantity).toBe(19);

    // (-1.5 x 40) + (-1 x 2) = -62 loss: Dr Inventory Shrinkage, Cr Inventory
    const je = db.table("journal")[0];
    const sum = (f: string) => je.lines.reduce((s: number, l: any) => s + Number(l[f] ?? 0), 0);
    expect(sum("debit")).toBe(62);
    expect(sum("credit")).toBe(62);
    expect(db.table("account").some((a) => a.code === "5920")).toBe(true);

    const again = await request(app).post(`/stock-counts/${id}/approve`).set(BOSS);
    expect(again.status).toBe(409);
    expect(db.table("ingredientMovement").filter((m) => m.type === "COUNT_ADJUSTMENT")).toHaveLength(1);
  });

  it("a rejected count leaves stock alone", async () => {
    const id = await startAndFill();
    await request(app).post(`/stock-counts/${id}/submit`).set(COUNTER);
    const res = await request(app).post(`/stock-counts/${id}/reject`).set(BOSS).send({ note: "Recount the freezer" });
    expect(res.status).toBe(200);
    expect(String(db.table("ingredient").find((i) => i.id === "cheese")!.currentQuantity)).toBe("10");
    expect(db.table("journal")).toHaveLength(0);
  });
});

describe("production (stock journal)", () => {
  it("turns ingredients into a prepared item at the standard make-up", async () => {
    const res = await request(app).post("/production").set(COOK).send({ outputId: "dough", quantity: 40 });
    expect(res.status).toBe(201);
    const flour = db.table("ingredient").find((i) => i.id === "flour")!;
    const dough = db.table("ingredient").find((i) => i.id === "dough")!;
    expect(String(flour.currentQuantity)).toBe("4"); // 10 - 0.15 x 40
    expect(String(dough.currentQuantity)).toBe("40");
    expect(Number(dough.costPerUnit)).toBe(1.5); // 0.15 kg x 10
    expect(Number(res.body.batch.totalCost)).toBe(60);
  });

  it("records what was really used and keeps the standard beside it", async () => {
    await request(app).post("/production").set(COOK).send({
      outputId: "dough", quantity: 40, lines: [{ ingredientId: "flour", quantityUsed: 6.5 }],
      reason: "Bag was damp",
    });
    const line = db.table("productionBatchLine")[0];
    expect(Number(line.quantityUsed)).toBe(6.5);
    expect(Number(line.standardQuantity)).toBe(6);
  });

  it("demands a reason when more was used than the recipe says", async () => {
    const res = await request(app).post("/production").set(COOK).send({
      outputId: "dough", quantity: 40, lines: [{ ingredientId: "flour", quantityUsed: 6.5 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/say why/i);
    expect(db.table("productionBatch")).toHaveLength(0);
    expect(String(db.table("ingredient").find((i) => i.id === "flour")!.currentQuantity)).toBe("10");
  });

  it("needs no reason when the kitchen used the standard amount or less", async () => {
    const res = await request(app).post("/production").set(COOK).send({
      outputId: "dough", quantity: 40, lines: [{ ingredientId: "flour", quantityUsed: 5.9 }],
    });
    expect(res.status).toBe(201);
  });

  it("numbers the journal entries in order and keeps the reason", async () => {
    const a = await request(app).post("/production").set(COOK).send({ outputId: "dough", quantity: 1 });
    const b = await request(app).post("/production").set(COOK).send({
      outputId: "dough", quantity: 10, lines: [{ ingredientId: "flour", quantityUsed: 2 }], reason: "Spilled some",
    });
    expect(a.body.batch.number).toBe(1);
    expect(b.body.batch.number).toBe(2);
    expect(b.body.batch.reason).toBe("Spilled some");
  });

  it("refuses to use more than is in stock unless told to", async () => {
    const res = await request(app).post("/production").set(COOK).send({ outputId: "dough", quantity: 100 });
    expect(res.status).toBe(409);
    expect(String(db.table("ingredient").find((i) => i.id === "flour")!.currentQuantity)).toBe("10");
  });

  it("needs the stock.produce permission", async () => {
    const res = await request(app).post("/production").set(COUNTER).send({ outputId: "dough", quantity: 1 });
    expect(res.status).toBe(403);
  });
});
