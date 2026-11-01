import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import bcrypt from "bcrypt";

const state = vi.hoisted(() => ({
  business: { id: "b1", shortCode: "ABC234", isActive: true, requireShift: false } as any,
  users: [] as any[],
  shifts: [] as any[],
  sales: [] as any[],
  openTabs: 0,
}));

const match = (row: any, where: any = {}) =>
  Object.entries(where).every(([k, v]: [string, any]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("not" in v) return row[k] !== v.not;
      if ("gte" in v || "lte" in v) return (v.gte ? row[k] >= v.gte : true) && (v.lte ? row[k] <= v.lte : true);
    }
    return row[k] === v;
  });

vi.mock("../../config/prisma", () => {
  const prisma: any = {
    $transaction: async (fn: any) => fn(prisma),
    $queryRaw: async () => [],
    business: {
      findFirst: async ({ where }: any) => (where.shortCode === state.business.shortCode ? state.business : null),
      findUnique: async () => state.business,
      update: async ({ data }: any) => Object.assign(state.business, data),
    },
    user: {
      findFirst: async ({ where, orderBy }: any) => {
        const rows = state.users.filter((u) => match(u, where));
        if (orderBy?.staffNumber === "desc") rows.sort((a, b) => b.staffNumber - a.staffNumber);
        return rows[0] ?? null;
      },
      findMany: async ({ where }: any) => state.users.filter((u) => match(u, where)),
      update: async ({ where, data }: any) => Object.assign(state.users.find((u) => u.id === where.id), data),
    },
    shift: {
      findFirst: async ({ where }: any) => state.shifts.find((s) => match(s, where)) ?? null,
      findFirstOrThrow: async ({ where }: any) => state.shifts.find((s) => match(s, where)),
      findMany: async ({ where }: any) => state.shifts.filter((s) => match(s, where)),
      create: async ({ data }: any) => {
        const s = { id: `s${state.shifts.length + 1}`, status: "OPEN", openedAt: new Date(Date.now() - 3600_000), takenOver: false, ...data };
        state.shifts.push(s);
        return s;
      },
      updateMany: async ({ where, data }: any) => {
        const rows = state.shifts.filter((s) => match(s, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
    sale: { findMany: async ({ where }: any) => state.sales.filter((s) => s.cashierId === where.cashierId) },
    order: { count: async () => state.openTabs },
    auditLog: { create: async () => ({}) },
  };
  return { prisma };
});

vi.mock("../../utils/jwt", () => ({
  signAccessToken: (p: any) => `access:${p.userId}:${(p.permissions ?? []).join("|")}`,
  signRefreshToken: (p: any) => `refresh:${p.userId}`,
  verifyAccessToken: () => ({}),
  verifyRefreshToken: () => ({}),
}));

vi.mock("../../middleware/auth", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.auth = {
      userId: String(req.headers["x-user"] ?? "u1"), businessId: "b1", role: String(req.headers["x-role"] ?? "CASHIER"),
      permissions: String(req.headers["x-perms"] ?? "").split(",").filter(Boolean),
    };
    next();
  },
  authorize: (...roles: string[]) => (req: any, res: any, next: any) => (roles.includes(req.auth.role) ? next() : res.status(403).json({ error: "role" })),
  requirePermission: (...required: string[]) => (req: any, res: any, next: any) =>
    required.some((p) => req.auth.permissions.includes(p)) ? next() : res.status(403).json({ error: "perm" }),
}));

vi.mock("@prisma/client", async () => {
  const { Decimal } = await import("@prisma/client/runtime/library");
  return { Prisma: { Decimal } };
});

import pinAuthRoutes from "../pinAuth";
import tillAccessRoutes from "../tillAccess";
import shiftRoutes from "../shifts";
import { requireOpenShift } from "../../middleware/requireOpenShift";

const app = express();
app.use(express.json());
app.use("/auth/pin-login", pinAuthRoutes);
app.use("/till-access", tillAccessRoutes);
app.post("/sales/checkout", (req: any, _res, next) => { req.auth = { userId: "u1", businessId: "b1", role: "CASHIER", permissions: [] }; next(); }, requireOpenShift, (_q, r) => r.json({ ok: true }));
app.use("/shifts", shiftRoutes);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message ?? err) }));

const MANAGER = { "x-user": "m1", "x-role": "MANAGER", "x-perms": "staff.manage,shift.use,shift.view,shift.open_for" };
const CASHIER = { "x-user": "u1", "x-perms": "shift.use,sales.create" };
const OWNER = { "x-user": "o1", "x-role": "OWNER", "x-perms": "shift.use,shift.view,staff.manage" };

beforeEach(async () => {
  state.business = { id: "b1", shortCode: "ABC234", isActive: true, requireShift: false };
  state.shifts = [];
  state.sales = [];
  state.openTabs = 0;
  state.users = [
    { id: "u1", businessId: "b1", name: "Ama", role: "CASHIER", isActive: true, staffNumber: 1, pinHash: await bcrypt.hash("4821", 4), pinFailedAttempts: 0, pinLockedUntil: null, extraPermissions: [], revokedPermissions: [], tokenVersion: 0 },
    { id: "u2", businessId: "b1", name: "Kojo", role: "CASHIER", isActive: true, staffNumber: null, pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null, extraPermissions: [], revokedPermissions: [], tokenVersion: 0 },
    { id: "m1", businessId: "b1", name: "Efua", role: "MANAGER", isActive: true, staffNumber: null, pinHash: await bcrypt.hash("4821", 4), pinFailedAttempts: 0, pinLockedUntil: null, extraPermissions: [], revokedPermissions: [], tokenVersion: 0 },
  ];
});

const login = (body: any) => request(app).post("/auth/pin-login").send(body);

describe("PIN login", () => {
  it("signs a cashier in with the till code, staff number and PIN", async () => {
    const r = await login({ businessCode: "abc-234", staffNumber: 1, pin: "4821" });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ id: "u1", role: "CASHIER" });
    expect(r.body.accessToken).toContain("sales.create");
    expect(r.body.refreshToken).toBe("refresh:u1");
  });

  it("gives the same answer for a wrong code, wrong number and wrong PIN", async () => {
    const msgs = new Set<string>();
    for (const body of [
      { businessCode: "ZZZZZZ", staffNumber: 1, pin: "4821" },
      { businessCode: "ABC234", staffNumber: 99, pin: "4821" },
      { businessCode: "ABC234", staffNumber: 1, pin: "9999" },
    ]) {
      const r = await login(body);
      expect(r.status).toBe(401);
      msgs.add(r.body.error);
    }
    expect(msgs.size).toBe(1);
  });

  it("never lets owners or managers in by PIN", async () => {
    state.users[2].staffNumber = 7;
    const r = await login({ businessCode: "ABC234", staffNumber: 7, pin: "4821" });
    expect(r.status).toBe(401);
  });

  it("locks after five wrong PINs, even for the right PIN, until unlocked", async () => {
    for (let i = 0; i < 5; i++) await login({ businessCode: "ABC234", staffNumber: 1, pin: "9999" });
    const locked = await login({ businessCode: "ABC234", staffNumber: 1, pin: "4821" });
    expect(locked.status).toBe(429);
    const unlock = await request(app).post("/till-access/u1/unlock").set(MANAGER);
    expect(unlock.status).toBe(200);
    expect((await login({ businessCode: "ABC234", staffNumber: 1, pin: "4821" })).status).toBe(200);
  });

  it("a deactivated cashier can't sign in", async () => {
    state.users[0].isActive = false;
    expect((await login({ businessCode: "ABC234", staffNumber: 1, pin: "4821" })).status).toBe(401);
  });
});

describe("till access (managers)", () => {
  it("lists only PIN-eligible staff with the till code", async () => {
    const r = await request(app).get("/till-access").set(MANAGER);
    expect(r.body.businessCode).toBe("ABC234");
    expect(r.body.staff.map((s: any) => s.name)).toEqual(["Ama", "Kojo"]);
    expect(r.body.staff[0]).toMatchObject({ hasPin: true, staffNumber: 1 });
  });

  it("gives a new PIN user the next staff number", async () => {
    const r = await request(app).put("/till-access/u2/pin").set(MANAGER).send({ pin: "7391" });
    expect(r.status).toBe(200);
    expect(r.body.user.staffNumber).toBe(2);
    expect((await login({ businessCode: "ABC234", staffNumber: 2, pin: "7391" })).status).toBe(200);
  });

  it("refuses weak PINs and non-cashier roles, and needs staff.manage", async () => {
    expect((await request(app).put("/till-access/u2/pin").set(MANAGER).send({ pin: "1234" })).status).toBe(400);
    expect((await request(app).put("/till-access/m1/pin").set(MANAGER).send({ pin: "7391" })).status).toBe(400);
    expect((await request(app).put("/till-access/u2/pin").set(CASHIER).send({ pin: "7391" })).status).toBe(403);
  });
});

describe("shifts and handover", () => {
  it("opens a shift once per cashier", async () => {
    expect((await request(app).post("/shifts/open").set(CASHIER).send({ openingFloat: 100, pin: "4821" })).status).toBe(201);
    const again = await request(app).post("/shifts/open").set(CASHIER).send({ openingFloat: 100, pin: "4821" });
    expect(again.status).toBe(409);
  });

  it("closing compares counted cash with float plus the cashier's cash sales only", async () => {
    await request(app).post("/shifts/open").set(CASHIER).send({ openingFloat: 100, pin: "4821" });
    state.sales = [
      { cashierId: "u1", paymentMethod: "CASH", total: "50" },
      { cashierId: "u1", paymentMethod: "MOBILE_MONEY", total: "30" },
      { cashierId: "u2", paymentMethod: "CASH", total: "999" },
    ];
    const r = await request(app).post("/shifts/close").set(CASHIER).send({ countedCash: 145 });
    expect(r.status).toBe(200);
    expect(r.body.shift).toMatchObject({ expectedCash: 150, countedCash: 145, variance: -5, salesCount: 2, salesTotal: 80 });
    expect(r.body.kind).toBe("SHORT");
  });

  it("won't close with open tabs", async () => {
    await request(app).post("/shifts/open").set(CASHIER).send({ openingFloat: 0, pin: "4821" });
    state.openTabs = 2;
    const r = await request(app).post("/shifts/close").set(CASHIER).send({ countedCash: 0 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("OPEN_TABS");
  });

  it("flags the gap when the next cashier recounts a different float", async () => {
    await request(app).post("/shifts/open").set(CASHIER).send({ openingFloat: 100, pin: "4821" });
    await request(app).post("/shifts/close").set(CASHIER).send({ countedCash: 500 });

    const offered = await request(app).get("/shifts/current").set({ ...CASHIER, "x-user": "u2" });
    expect(offered.body.handovers).toHaveLength(1);
    expect(offered.body.handovers[0].countedCash).toBe(500);

    state.users[1].pinHash = await bcrypt.hash("7391", 4);
    const take = await request(app).post("/shifts/open").set({ ...CASHIER, "x-user": "u2" })
      .send({ openingFloat: 480, pin: "7391", takeOverFromShiftId: offered.body.handovers[0].id });
    expect(take.status).toBe(201);
    expect(take.body.shift.handoverDifference).toBe(-20);

    const again = await request(app).post("/shifts/open").set({ ...MANAGER })
      .send({ openingFloat: 500, takeOverFromShiftId: offered.body.handovers[0].id });
    expect(again.status).toBe(409);
  });

  it("only managers see everyone's history, and only the owner changes the setting", async () => {
    expect((await request(app).get("/shifts").set(CASHIER)).status).toBe(403);
    expect((await request(app).get("/shifts").set(MANAGER)).status).toBe(200);
    expect((await request(app).put("/shifts/settings").set(MANAGER).send({ requireShift: true })).status).toBe(403);
    expect((await request(app).put("/shifts/settings").set(OWNER).send({ requireShift: true })).status).toBe(200);
    expect(state.business.requireShift).toBe(true);
  });
});

describe("PIN needed to open a shift", () => {
  it("refuses a cashier who leaves the PIN out or gets it wrong", async () => {
    const none = await request(app).post("/shifts/open").set(CASHIER).send({ openingFloat: 0 });
    // 403, not 401: the client treats a 401 as an expired session and would
    // retry, counting every wrong PIN twice towards the lockout.
    expect(none.status).toBe(403);
    const wrong = await request(app).post("/shifts/open").set(CASHIER).send({ openingFloat: 0, pin: "9999" });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe("WRONG_PIN");
    expect(state.shifts).toHaveLength(0);
  });

  it("locks the cashier out after five wrong PINs, even for the right one", async () => {
    for (let i = 0; i < 5; i++) await request(app).post("/shifts/open").set(CASHIER).send({ openingFloat: 0, pin: "9999" });
    const r = await request(app).post("/shifts/open").set(CASHIER).send({ openingFloat: 0, pin: "4821" });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe("PIN_LOCKED");
  });

  it("a cashier with no PIN cannot open their own shift", async () => {
    const r = await request(app).post("/shifts/open").set({ ...CASHIER, "x-user": "u2" }).send({ openingFloat: 0, pin: "4821" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("NO_PIN");
  });

  it("managers are not asked for a PIN", async () => {
    const r = await request(app).post("/shifts/open").set(MANAGER).send({ openingFloat: 50 });
    expect(r.status).toBe(201);
  });

  it("tells the screen whether a PIN is needed and set", async () => {
    const r = await request(app).get("/shifts/current").set({ ...CASHIER, "x-user": "u2" });
    expect(r.body.pin).toEqual({ required: true, set: false });
    const m = await request(app).get("/shifts/current").set(MANAGER);
    expect(m.body.pin.required).toBe(false);
  });
});

describe("manager opens a shift for a cashier", () => {
  it("works without the cashier's PIN, and records who opened it", async () => {
    const r = await request(app).post("/shifts/open-for").set(MANAGER).send({ userId: "u2", openingFloat: 200 });
    expect(r.status).toBe(201);
    expect(r.body.shift).toMatchObject({ userId: "u2", openedById: "m1", openingFloat: 200 });
    // the cashier now has an open shift and can sell
    state.business.requireShift = true;
    const sale = await request(app).post("/sales/checkout");
    expect(sale.status).toBe(409); // gate test route is fixed to u1, who has none: proves the gate is per cashier
  });

  it("is manager-only and for cashiers only", async () => {
    expect((await request(app).post("/shifts/open-for").set(CASHIER).send({ userId: "u2", openingFloat: 0 })).status).toBe(403);
    expect((await request(app).post("/shifts/open-for").set(MANAGER).send({ userId: "m1", openingFloat: 0 })).status).toBe(400);
    expect((await request(app).post("/shifts/open-for").set(MANAGER).send({ userId: "nobody", openingFloat: 0 })).status).toBe(404);
  });

  it("refuses a second open shift for the same cashier", async () => {
    await request(app).post("/shifts/open-for").set(MANAGER).send({ userId: "u2", openingFloat: 0 });
    expect((await request(app).post("/shifts/open-for").set(MANAGER).send({ userId: "u2", openingFloat: 0 })).status).toBe(409);
  });

  it("lists cashiers with PIN and shift status", async () => {
    await request(app).post("/shifts/open-for").set(MANAGER).send({ userId: "u2", openingFloat: 0 });
    const r = await request(app).get("/shifts/cashiers").set(MANAGER);
    expect(r.body.cashiers).toEqual([
      { id: "u1", name: "Ama", hasPin: true, hasOpenShift: false },
      { id: "u2", name: "Kojo", hasPin: false, hasOpenShift: true },
    ]);
  });
});

describe("require-shift gate", () => {
  it("does nothing while the setting is off", async () => {
    expect((await request(app).post("/sales/checkout")).status).toBe(200);
  });
  it("blocks selling without an open shift, allows it with one", async () => {
    state.business.requireShift = true;
    const blocked = await request(app).post("/sales/checkout");
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("SHIFT_NOT_OPEN");
    await request(app).post("/shifts/open").set(CASHIER).send({ openingFloat: 0, pin: "4821" });
    expect((await request(app).post("/sales/checkout")).status).toBe(200);
  });
});
