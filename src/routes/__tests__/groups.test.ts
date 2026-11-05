import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const db = vi.hoisted(() => ({
  businesses: [] as any[],
  users: [] as any[],
  groups: [] as any[],
  categories: [] as any[],
  products: [] as any[],
  sales: [] as any[],
  seq: 0,
}));
const id = (p: string) => `${p}${++db.seq}`;

vi.mock("../../config/prisma", () => {
  const prisma: any = {
    $transaction: async (fn: any) => fn(prisma),
    businessGroup: {
      create: async ({ data }: any) => { const g = { id: id("g"), ...data }; db.groups.push(g); return g; },
      findUnique: async ({ where }: any) => db.groups.find((g) => g.id === where.id) ?? null,
    },
    business: {
      findUnique: async ({ where }: any) => db.businesses.find((b) => b.id === where.id) ?? null,
      findFirst: async ({ where }: any) =>
        db.businesses.find((b) => b.id === where.id && (!where.groupId || b.groupId === where.groupId)) ?? null,
      findMany: async ({ where }: any) => db.businesses.filter((b) => b.groupId === where.groupId),
      create: async ({ data }: any) => { const b = { id: id("b"), isActive: true, ...data }; db.businesses.push(b); return b; },
      update: async ({ where, data }: any) => Object.assign(db.businesses.find((b) => b.id === where.id), data),
    },
    user: {
      findUnique: async ({ where }: any) => db.users.find((u) => u.id === where.id || u.email === where.email) ?? null,
      create: async ({ data }: any) => { const u = { id: id("u"), ...data }; db.users.push(u); return u; },
      update: async ({ where, data }: any) => Object.assign(db.users.find((u) => u.id === where.id), data),
    },
    category: {
      findMany: async ({ where }: any) => db.categories.filter((c) => c.businessId === where.businessId),
      create: async ({ data }: any) => { const c = { id: id("c"), ...data }; db.categories.push(c); return c; },
    },
    product: {
      findMany: async ({ where }: any) => db.products.filter((p) => p.businessId === where.businessId),
      create: async ({ data }: any) => { const p = { id: id("p"), ...data }; db.products.push(p); return p; },
      update: async ({ where, data }: any) => Object.assign(db.products.find((p) => p.id === where.id), data),
    },
    sale: {
      groupBy: async ({ by, where }: any) => {
        const rows = db.sales.filter((s) => where.businessId.in.includes(s.businessId) && s.status === where.status);
        const key = (s: any) => by.map((k: string) => s[k]).join("|");
        const groups = new Map<string, any[]>();
        for (const s of rows) groups.set(key(s), [...(groups.get(key(s)) ?? []), s]);
        return [...groups.values()].map((g) => ({
          businessId: g[0].businessId,
          paymentMethod: g[0].paymentMethod,
          _sum: { total: g.reduce((a, s) => a + s.total, 0) },
          _count: { _all: g.length },
        }));
      },
    },
    businessDay: { findMany: async () => [], findFirst: async () => null },
    auditLog: { create: async () => ({}) },
    account: { findFirst: async () => null, create: async () => ({}), createMany: async () => ({}), findMany: async () => [] },
  };
  return { prisma };
});

vi.mock("@prisma/client", async () => {
  const { Decimal } = await import("@prisma/client/runtime/library");
  return { Prisma: { Decimal } };
});
vi.mock("../../services/seedAccounts", () => ({ seedDefaultChartOfAccounts: async () => undefined }));
vi.mock("bcrypt", () => ({ default: { hash: async (p: string) => `hash:${p}`, compare: async () => true } }));
vi.mock("../../utils/jwt", () => ({
  signAccessToken: (p: any) => `access:${p.userId}:${p.businessId}`,
  signRefreshToken: () => "refresh",
  verifyRefreshToken: () => ({}),
}));
vi.mock("../../middleware/auth", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.auth = { userId: String(req.headers["x-user"]), businessId: String(req.headers["x-biz"]), role: String(req.headers["x-role"] ?? "OWNER"), permissions: [] };
    next();
  },
  authorize: (...roles: string[]) => (req: any, res: any, next: any) =>
    roles.includes(req.auth.role) ? next() : res.status(403).json({ error: "role" }),
}));

import groupRoutes from "../groups";

const app = express();
app.use(express.json());
app.use("/groups", groupRoutes);

const as = (userId: string, biz: string, role = "OWNER") => ({ "x-user": userId, "x-biz": biz, "x-role": role });

beforeEach(() => {
  Object.assign(db, { businesses: [], users: [], groups: [], categories: [], products: [], sales: [], seq: 0 });
  db.businesses.push({ id: "hq", name: "Pizza Inn Accra Mall", businessType: "restaurant", currency: "GHS", restaurantModeEnabled: true, requireOpenDay: true, requireShift: false, branchType: "OUTLET", groupId: null, isActive: true });
  db.users.push({ id: "owner", businessId: "hq", email: "o@x.com", name: "Owner", role: "OWNER", extraPermissions: [], revokedPermissions: [], tokenVersion: 0, groupAdminId: null, activeBusinessId: null });
  db.users.push({ id: "cash", businessId: "hq", email: "c@x.com", name: "Cashier", role: "CASHIER", extraPermissions: [], revokedPermissions: [], tokenVersion: 0, groupAdminId: null, activeBusinessId: null });
  db.categories.push({ id: "cat1", businessId: "hq", name: "Pizza", description: null, isActive: true });
  db.products.push({ id: "pz1", businessId: "hq", categoryId: "cat1", name: "Margherita", sku: "MARG", unit: "unit", costPrice: 20, sellingPrice: 55, isActive: true, description: null, imageUrl: null, barcode: null });
});

async function enable() {
  return request(app).post("/groups/enable").set(as("owner", "hq")).send({ name: "Pizza Inn Ghana" });
}

describe("chains", () => {
  it("the owner turns the business into a chain once", async () => {
    expect((await enable()).status).toBe(201);
    expect((await enable()).status).toBe(409);
    const me = await request(app).get("/groups/me").set(as("owner", "hq"));
    expect(me.body.isGroupAdmin).toBe(true);
    expect(me.body.branches).toHaveLength(1);
  });

  it("a cashier or manager cannot enable, add, switch or see the group report", async () => {
    await enable();
    expect((await request(app).post("/groups/enable").set(as("cash", "hq", "CASHIER")).send({})).status).toBe(403);
    expect((await request(app).post("/groups/branches").set(as("cash", "hq", "CASHIER")).send({ name: "Branch X" })).status).toBe(403);
    expect((await request(app).post("/groups/switch").set(as("cash", "hq", "CASHIER")).send({ businessId: "hq" })).status).toBe(403);
    expect((await request(app).get("/groups/report").set(as("cash", "hq", "CASHIER")).query({ from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z" })).status).toBe(403);
  });

  it("adds a branch with its own manager and the shared menu, with no stock carried over", async () => {
    await enable();
    const res = await request(app).post("/groups/branches").set(as("owner", "hq")).send({
      name: "Kwashieman", copyMenu: true, manager: { name: "Kojo", email: "kojo@x.com", password: "longenough1" },
    });
    expect(res.status).toBe(201);
    const branchId = res.body.branch.id;
    const manager = db.users.find((u) => u.email === "kojo@x.com");
    expect(manager.businessId).toBe(branchId);
    expect(manager.role).toBe("MANAGER");
    const copied = db.products.filter((p) => p.businessId === branchId);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ name: "Margherita", sellingPrice: 55, currentQuantity: 0 });
    expect(db.categories.filter((c) => c.businessId === branchId)).toHaveLength(1);
    expect(db.businesses.find((b) => b.id === branchId)).toMatchObject({ groupId: db.groups[0].id, restaurantModeEnabled: true });
  });

  it("syncing the menu updates prices on the other branch instead of duplicating", async () => {
    await enable();
    const branch = (await request(app).post("/groups/branches").set(as("owner", "hq")).send({ name: "Kwashieman", copyMenu: true })).body.branch;
    db.products.find((p) => p.id === "pz1").sellingPrice = 60;
    const sync = await request(app).post(`/groups/branches/${branch.id}/sync-menu`).set(as("owner", "hq")).send({});
    expect(sync.body.menu).toEqual({ created: 0, updated: 1 });
    expect(db.products.filter((p) => p.businessId === branch.id)[0].sellingPrice).toBe(60);
  });

  it("a production branch gets no menu", async () => {
    await enable();
    const res = await request(app).post("/groups/branches").set(as("owner", "hq")).send({ name: "Central Kitchen", branchType: "PRODUCTION", copyMenu: true });
    expect(res.body.menu).toBeNull();
    const sync = await request(app).post(`/groups/branches/${res.body.branch.id}/sync-menu`).set(as("owner", "hq")).send({});
    expect(sync.status).toBe(400);
  });

  it("switching branch returns a token for that branch, and refuses a branch outside the chain", async () => {
    await enable();
    const branch = (await request(app).post("/groups/branches").set(as("owner", "hq")).send({ name: "Kwashieman" })).body.branch;
    const ok = await request(app).post("/groups/switch").set(as("owner", "hq")).send({ businessId: branch.id });
    expect(ok.body.accessToken).toBe(`access:owner:${branch.id}`);
    expect(db.users.find((u) => u.id === "owner").activeBusinessId).toBe(branch.id);
    db.businesses.push({ id: "other", name: "Someone else", groupId: null, isActive: true });
    expect((await request(app).post("/groups/switch").set(as("owner", "hq")).send({ businessId: "other" })).status).toBe(404);
  });

  it("the group report shows each branch's takings and the chain total", async () => {
    await enable();
    const k = (await request(app).post("/groups/branches").set(as("owner", "hq")).send({ name: "Kwashieman" })).body.branch;
    db.sales.push(
      { businessId: "hq", status: "COMPLETED", paymentMethod: "CASH", total: 100 },
      { businessId: "hq", status: "COMPLETED", paymentMethod: "MOBILE_MONEY", total: 50 },
      { businessId: k.id, status: "COMPLETED", paymentMethod: "CASH", total: 300 },
      { businessId: k.id, status: "CANCELLED", paymentMethod: "CASH", total: 80 },
    );
    const res = await request(app).get("/groups/report").set(as("owner", "hq")).query({ from: "2026-11-01T00:00:00.000Z", to: "2026-11-30T00:00:00.000Z" });
    const hq = res.body.rows.find((r: any) => r.id === "hq");
    const kw = res.body.rows.find((r: any) => r.id === k.id);
    expect(hq).toMatchObject({ sales: 2, total: 150, byMethod: { CASH: 100, MOBILE_MONEY: 50 } });
    expect(kw).toMatchObject({ sales: 1, total: 300, cancelled: 1 });
    expect(res.body.totals).toMatchObject({ sales: 3, total: 450, byMethod: { CASH: 400, MOBILE_MONEY: 50 } });
  });
});
