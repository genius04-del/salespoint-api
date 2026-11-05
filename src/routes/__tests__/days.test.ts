import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---- In-memory stand-in for Prisma (no database needed) --------------------
const state = vi.hoisted(() => ({
  openDay: null as any,
  closedDays: [] as any[],
  counts: [] as any[],
  sales: [] as any[],
  expenses: [] as any[],
  supplierPayments: [] as any[],
  openOrders: 0,
  journals: [] as any[],
  accounts: [] as any[],
  requireOpenDay: false,
  dayCounter: 0,
}));

vi.mock("../../config/prisma", () => {
  const prisma: any = {
    $queryRaw: async () => [],
    $transaction: async (fn: any) => fn(prisma),
    business: {
      findUnique: async () => ({ requireOpenDay: state.requireOpenDay, restaurantModeEnabled: false }),
      update: async () => ({ dayCounter: ++state.dayCounter }),
    },
    businessDay: {
      findFirst: async (args: any) => {
        if (args?.where?.status === "OPEN") return state.openDay;
        if (args?.where?.status === "CLOSED") return state.closedDays[0] ?? null;
        return null;
      },
      create: async ({ data }: any) => {
        state.openDay = { id: "day1", status: "OPEN", openedAt: new Date(Date.now() - 3600_000), closedAt: null, ...data };
        return state.openDay;
      },
      update: async ({ data }: any) => {
        state.openDay = { ...state.openDay, ...data };
        state.closedDays.unshift({ ...state.openDay, counts: state.counts });
        const closed = state.openDay;
        state.openDay = null;
        return closed;
      },
    },
    businessDayCount: { createMany: async ({ data }: any) => void state.counts.push(...data) },
    order: { count: async () => state.openOrders },
    sale: { findMany: async (args: any) => (args.where.status === "COMPLETED" ? state.sales : []) },
    expense: { findMany: async () => state.expenses },
    purchasePayment: { findMany: async () => state.supplierPayments },
    user: { findMany: async () => [{ id: "u1", name: "Ama Manager" }, { id: "u2", name: "Kojo Cashier" }] },
    account: {
      findFirst: async ({ where }: any) => state.accounts.find((a) => a.code === where.code) ?? null,
      create: async ({ data }: any) => void state.accounts.push({ id: `acc-${data.code}`, ...data }),
      findMany: async ({ where }: any) => state.accounts.filter((a) => where.code.in.includes(a.code)),
    },
    journalEntry: {
      create: async ({ data }: any) => {
        const entry = { id: `je${state.journals.length + 1}`, ...data, lines: data.lines.create };
        state.journals.push(entry);
        return entry;
      },
    },
    auditLog: { create: async () => ({}) },
  };
  return { prisma };
});

// Prisma's generated client needs a database engine; only its Decimal maths
// is used here, and that ships in the runtime library.
vi.mock("@prisma/client", async () => {
  const { Decimal } = await import("@prisma/client/runtime/library");
  return { Prisma: { Decimal } };
});

// Auth stand-in: permissions come from a header so each test picks a role.
vi.mock("../../middleware/auth", () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.auth = {
      userId: "u1",
      businessId: "b1",
      role: String(req.headers["x-role"] ?? "MANAGER"),
      permissions: String(req.headers["x-perms"] ?? "").split(",").filter(Boolean),
    };
    next();
  },
  authorize: (...roles: string[]) => (req: any, res: any, next: any) =>
    roles.includes(req.auth.role) ? next() : res.status(403).json({ error: "role" }),
  requirePermission: (...required: string[]) => (req: any, res: any, next: any) =>
    required.some((p) => req.auth.permissions.includes(p)) ? next() : res.status(403).json({ error: "perm" }),
}));

import dayRoutes from "../days";
import { requireOpenDay } from "../../middleware/requireOpenDay";

const app = express();
app.use(express.json());
app.post("/sales/checkout", (req: any, _res, next) => {
  req.auth = { businessId: "b1", userId: "u1", role: "CASHIER", permissions: [] };
  next();
}, requireOpenDay, (_req, res) => res.json({ ok: true }));
app.use("/days", dayRoutes);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message ?? err) }));

const MANAGER = { "x-role": "MANAGER", "x-perms": "day.view,day.open,day.close" };
const CASHIER = { "x-role": "CASHIER", "x-perms": "day.view,day.open" };

const sale = (method: string, total: number, cashierId = "u2", name = "Kojo Cashier") => ({
  paymentMethod: method, total, cashierId, cashier: { name },
});

beforeEach(() => {
  state.openDay = null;
  state.closedDays = [];
  state.counts = [];
  state.sales = [];
  state.expenses = [];
  state.supplierPayments = [];
  state.openOrders = 0;
  state.journals = [];
  state.accounts = [
    { id: "a1000", code: "1000" }, { id: "a1010", code: "1010" }, { id: "a1020", code: "1020" },
  ];
  state.requireOpenDay = false;
  state.dayCounter = 0;
});

async function openDay(float = 100) {
  return request(app).post("/days/open").set(MANAGER).send({ openingFloat: float });
}

describe("opening the day", () => {
  it("opens with a float, and refuses to open a second day", async () => {
    const first = await openDay(100);
    expect(first.status).toBe(201);
    expect(first.body.day.openingFloat).toBe(100);
    const second = await openDay(50);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("DAY_ALREADY_OPEN");
  });

  it("a user without day.open cannot open it", async () => {
    const res = await request(app).post("/days/open").set({ "x-perms": "day.view" }).send({});
    expect(res.status).toBe(403);
  });
});

describe("finance posting numbers and notes/coins", () => {
  it("numbers each day FP-style, one after another", async () => {
    const first = await openDay(0);
    expect(first.body.day.number).toBe(1);
  });

  it("keeps the notes and coins counted for the float, and refuses a count that does not add up", async () => {
    const bad = await request(app).post("/days/open").set(MANAGER).send({ openingFloat: 100, denominations: { "50": 1, "20": 1 } });
    expect(bad.status).toBe(400);
    const ok = await request(app).post("/days/open").set(MANAGER).send({ openingFloat: 100, denominations: { "50": 1, "20": 2, "5": 2, "0.5": 0 } });
    expect(ok.status).toBe(201);
    expect(ok.body.day.openDenominations).toEqual({ "50": 1, "20": 2, "5": 2 });
  });

  it("keeps the notes and coins counted at close, and checks them against the cash counted", async () => {
    await openDay(100);
    const bad = await request(app).post("/days/close").set(MANAGER).send({ counts: [{ method: "CASH", counted: 100 }], denominations: { "50": 1 } });
    expect(bad.status).toBe(400);
    const ok = await request(app).post("/days/close").set(MANAGER).send({ counts: [{ method: "CASH", counted: 100 }], denominations: { "50": 2 } });
    expect(ok.status).toBe(200);
    expect(ok.body.day.closeDenominations).toEqual({ "50": 2 });
  });
});

describe("closing the day (cash-up)", () => {
  it("closes cleanly when the count matches, and posts nothing to the ledger", async () => {
    await openDay(100);
    state.sales = [sale("CASH", 400), sale("MOBILE_MONEY", 250)];
    const res = await request(app).post("/days/close").set(MANAGER).send({
      counts: [{ method: "CASH", counted: 500 }, { method: "MOBILE_MONEY", counted: 250 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(true);
    expect(res.body.day.status).toBe("CLOSED");
    expect(res.body.day.totalVariance).toBe(0);
    expect(state.journals).toHaveLength(0);
  });

  it("subtracts expenses and supplier payments from expected cash", async () => {
    await openDay(100);
    state.sales = [sale("CASH", 400)];
    state.expenses = [{ amount: 30, paymentAccount: { code: "1000" } }];
    state.supplierPayments = [{ amount: 20, method: "CASH" }];
    const res = await request(app).post("/days/close").set(MANAGER).send({
      counts: [{ method: "CASH", counted: 450 }], // 100 + 400 - 30 - 20
    });
    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(true);
  });

  it("refuses to close on a shortage until the manager confirms it", async () => {
    await openDay(100);
    state.sales = [sale("CASH", 400)];
    const res = await request(app).post("/days/close").set(MANAGER).send({
      counts: [{ method: "CASH", counted: 480 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("VARIANCE_NOT_CONFIRMED");
    expect(res.body.totalVariance).toBe(-20);
    expect(state.openDay).not.toBeNull(); // still open
  });

  it("requires a written reason to close with a difference", async () => {
    await openDay(100);
    state.sales = [sale("CASH", 400)];
    const res = await request(app).post("/days/close").set(MANAGER).send({
      counts: [{ method: "CASH", counted: 480 }],
      acceptVariance: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NOTE_REQUIRED");
  });

  it("closes with a confirmed shortage and posts a BALANCED Cash Over/Short entry", async () => {
    await openDay(100);
    state.sales = [sale("CASH", 400)];
    const res = await request(app).post("/days/close").set(MANAGER).send({
      counts: [{ method: "CASH", counted: 480 }],
      acceptVariance: true,
      notes: "GH₵20 short, change given wrongly",
    });
    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(false);
    expect(res.body.day.totalVariance).toBe(-20);

    expect(state.journals).toHaveLength(1);
    const lines = state.journals[0].lines;
    const debit = lines.reduce((s: number, l: any) => s + Number(l.debit), 0);
    const credit = lines.reduce((s: number, l: any) => s + Number(l.credit), 0);
    expect(debit).toBe(20);
    expect(credit).toBe(20); // double-entry holds
    expect(state.accounts.some((a) => a.code === "5910")).toBe(true); // Cash Over/Short created on first use
    expect(state.counts.find((c) => c.method === "CASH").journalEntryId).toBe("je1");
  });

  it("an overage debits the money account and credits Cash Over/Short", async () => {
    await openDay(0);
    state.sales = [sale("CASH", 100)];
    await request(app).post("/days/close").set(MANAGER).send({
      counts: [{ method: "CASH", counted: 110 }],
      acceptVariance: true,
      notes: "customer overpaid, no change given",
    });
    const lines = state.journals[0].lines;
    const cashLine = lines.find((l: any) => l.accountId === "a1000");
    expect(Number(cashLine.debit)).toBe(10);
  });

  it("will not close when a counted method with money expected is left blank", async () => {
    await openDay(0);
    state.sales = [sale("CASH", 100), sale("MOBILE_MONEY", 50)];
    const res = await request(app).post("/days/close").set(MANAGER).send({
      counts: [{ method: "CASH", counted: 100 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("COUNT_MISSING");
    expect(state.openDay).not.toBeNull();
  });

  it("will not close while restaurant tabs are still open", async () => {
    await openDay(0);
    state.openOrders = 2;
    const res = await request(app).post("/days/close").set(MANAGER).send({ counts: [] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OPEN_TABS");
  });

  it("a cashier (day.open, no day.close) cannot close the day", async () => {
    await openDay(0);
    const res = await request(app).post("/days/close").set(CASHIER).send({ counts: [] });
    expect(res.status).toBe(403);
  });

  it("says so clearly when there is no open day", async () => {
    const res = await request(app).post("/days/close").set(MANAGER).send({ counts: [] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NO_OPEN_DAY");
  });
});

describe("what each person can see while the day is open", () => {
  it("a cashier sees only their own totals, not the whole shop's expected money", async () => {
    await openDay(100);
    state.sales = [sale("CASH", 400)];
    const res = await request(app).get("/days/current").set(CASHIER);
    expect(res.status).toBe(200);
    expect(res.body.expected).toBeUndefined();
    expect(res.body.byCashier).toBeUndefined();
    expect(res.body.mine).toBeDefined();
  });

  it("a manager sees expected totals per method and per cashier", async () => {
    await openDay(100);
    state.sales = [sale("CASH", 400), sale("MOBILE_MONEY", 250)];
    const res = await request(app).get("/days/current").set(MANAGER);
    const cash = res.body.expected.find((r: any) => r.method === "CASH");
    expect(cash.expected).toBe(500);
    expect(res.body.byCashier[0].name).toBe("Kojo Cashier");
  });

  it("with no open day, suggests yesterday's counted cash as the new float", async () => {
    state.closedDays = [{ id: "d0", closedAt: new Date(), totalVariance: 0, counts: [{ method: "CASH", counted: 320 }] }];
    const res = await request(app).get("/days/current").set(MANAGER);
    expect(res.body.day).toBeNull();
    expect(res.body.suggestedFloat).toBe(320);
  });
});

describe("the optional 'day must be open' guard", () => {
  it("does nothing when the Owner hasn't switched it on", async () => {
    const res = await request(app).post("/sales/checkout");
    expect(res.status).toBe(200);
  });

  it("blocks selling when switched on and no day is open", async () => {
    state.requireOpenDay = true;
    const res = await request(app).post("/sales/checkout");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DAY_NOT_OPEN");
  });

  it("allows selling once the day is open", async () => {
    state.requireOpenDay = true;
    await openDay(0);
    const res = await request(app).post("/sales/checkout");
    expect(res.status).toBe(200);
  });
});
