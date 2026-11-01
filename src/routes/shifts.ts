import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import bcrypt from "bcrypt";
import { authenticate, authorize, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import {
  afterFailedPin, expectedShiftCash, handoverDifference, lockMinutesLeft, PIN_ROLES, shiftVariance,
} from "../services/shifts";
import { addTotal, emptyTotals, round2 } from "../services/dayClose";

const router = Router();
router.use(authenticate);

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? null : Number(d));

// What a cashier took between two moments, by payment method.
async function shiftFigures(db: any, businessId: string, userId: string, from: Date, to: Date) {
  const sales: any[] = await db.sale.findMany({
    where: { businessId, cashierId: userId, status: "COMPLETED", paymentStatus: "SUCCESSFUL", createdAt: { gte: from, lte: to } },
    select: { paymentMethod: true, total: true },
  });
  const totals = emptyTotals();
  let all = 0;
  for (const s of sales) {
    addTotal(totals, s.paymentMethod, Number(s.total));
    all = round2(all + Number(s.total));
  }
  return { count: sales.length, total: all, totals, cash: totals.CASH };
}

function serialize(s: any, names: Map<string, string>) {
  return {
    id: s.id,
    userId: s.userId,
    userName: names.get(s.userId) ?? null,
    status: s.status,
    openedAt: s.openedAt,
    openingFloat: num(s.openingFloat),
    openNotes: s.openNotes,
    openedById: s.openedById ?? null,
    openedByName: s.openedById ? names.get(s.openedById) ?? null : null,
    takeOverFromId: s.takeOverFromId,
    handoverDifference: num(s.handoverDifference),
    closedAt: s.closedAt,
    expectedCash: num(s.expectedCash),
    countedCash: num(s.countedCash),
    variance: num(s.variance),
    closeNotes: s.closeNotes,
    salesCount: s.salesCount,
    salesTotal: num(s.salesTotal),
  };
}

async function namesFor(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (!unique.length) return new Map<string, string>();
  const users: any[] = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name as string]));
}

// ---- GET /shifts/current ----
// My open shift with live figures, the Owner's setting, and any closed shifts
// I could take over from (the till drawer someone just handed in).
router.get("/current", requirePermission("shift.use", "shift.view"), async (req, res) => {
  const { businessId, userId } = req.auth!;
  const [business, me, mine, handovers] = await Promise.all([
    prisma.business.findUnique({ where: { id: businessId }, select: { requireShift: true } }),
    prisma.user.findFirst({ where: { id: userId, businessId } }),
    prisma.shift.findFirst({ where: { businessId, userId, status: "OPEN" } }),
    prisma.shift.findMany({
      where: { businessId, status: "CLOSED", takenOver: false },
      orderBy: { closedAt: "desc" },
      take: 5,
    }),
  ]);

  const names = await namesFor([mine?.userId, mine?.openedById, ...handovers.map((h: any) => h.userId)]);
  let live = null;
  if (mine) {
    const now = new Date();
    const f = await shiftFigures(prisma, businessId, userId, mine.openedAt, now);
    live = {
      asOf: now,
      salesCount: f.count,
      salesTotal: f.total,
      byMethod: f.totals,
      expectedCash: expectedShiftCash(Number(mine.openingFloat), f.cash),
    };
  }

  return res.json({
    requireShift: business?.requireShift ?? false,
    // Cashiers must type their PIN to open a shift; a manager can open it for them instead.
    pin: { required: needsPin(me?.role), set: !!me?.pinHash },
    shift: mine ? serialize(mine, names) : null,
    live,
    handovers: handovers
      .filter((h: any) => h.userId !== userId)
      .map((h: any) => ({ id: h.id, userName: names.get(h.userId) ?? null, closedAt: h.closedAt, countedCash: num(h.countedCash) })),
  });
});

// Cashiers and kitchen staff prove it is really them with their PIN before a
// drawer is put in their name. Owners and managers are already signed in with
// a password, so they are not asked.
function needsPin(role: string | undefined) {
  return !!role && (PIN_ROLES as readonly string[]).includes(role);
}

class PinProblem extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function verifyOwnPin(user: any, pin: string | undefined) {
  if (!user.pinHash) {
    throw new PinProblem(403, "NO_PIN", "You don't have a PIN yet. Ask a manager to set your PIN, or to open your shift for you.");
  }
  const wait = lockMinutesLeft(user.pinLockedUntil);
  if (wait > 0) {
    throw new PinProblem(429, "PIN_LOCKED", `Too many wrong PINs. Locked for ${wait} more minute${wait === 1 ? "" : "s"}. Ask a manager to unlock you or open your shift.`);
  }
  if (!pin || !(await bcrypt.compare(pin, user.pinHash))) {
    const next = afterFailedPin(user.pinFailedAttempts ?? 0);
    await prisma.user.update({ where: { id: user.id }, data: { pinFailedAttempts: next.pinFailedAttempts, pinLockedUntil: next.pinLockedUntil } });
    throw new PinProblem(403, "WRONG_PIN", next.locked ? "Wrong PIN. You are now locked out for a few minutes. Ask a manager to open your shift." : "Wrong PIN.");
  }
  if (user.pinFailedAttempts || user.pinLockedUntil) {
    await prisma.user.update({ where: { id: user.id }, data: { pinFailedAttempts: 0, pinLockedUntil: null } });
  }
}

interface NewShift {
  businessId: string;
  userId: string; // whose shift it is
  openedById: string | null; // the manager, when opened on someone's behalf
  openingFloat: number;
  takeOverFromShiftId?: string;
  notes?: string;
}

async function createShift(p: NewShift) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const already = await tx.shift.findFirst({ where: { businessId: p.businessId, userId: p.userId, status: "OPEN" } });
    if (already) throw new Error("ALREADY_OPEN");

    let diff: number | null = null;
    if (p.takeOverFromShiftId) {
      const prev = await tx.shift.findFirst({ where: { id: p.takeOverFromShiftId, businessId: p.businessId, status: "CLOSED" } });
      if (!prev) throw new Error("TAKEOVER_NOT_FOUND");
      // Claim it first, so two people can't both take over the same drawer.
      const claimed = await tx.shift.updateMany({ where: { id: prev.id, takenOver: false }, data: { takenOver: true } });
      if (claimed.count !== 1) throw new Error("ALREADY_TAKEN_OVER");
      diff = handoverDifference(p.openingFloat, Number(prev.countedCash ?? 0));
    }

    return tx.shift.create({
      data: {
        businessId: p.businessId,
        userId: p.userId,
        openedById: p.openedById,
        openingFloat: p.openingFloat,
        openNotes: p.notes,
        takeOverFromId: p.takeOverFromShiftId ?? null,
        handoverDifference: diff,
      },
    });
  });
}

function mapOpenError(err: any, res: any) {
  if (err instanceof PinProblem) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err.message === "ALREADY_OPEN") return res.status(409).json({ error: "There is already an open shift for this cashier.", code: "SHIFT_ALREADY_OPEN" });
  if (err.message === "TAKEOVER_NOT_FOUND") return res.status(404).json({ error: "That shift can't be taken over." });
  if (err.message === "ALREADY_TAKEN_OVER") return res.status(409).json({ error: "Someone has already taken over from that shift." });
  return null;
}

// ---- POST /shifts/open ---- open MY shift (cashiers must type their PIN)
const openSchema = z.object({
  openingFloat: z.number().min(0).max(100_000_000),
  pin: z.string().regex(/^\d{4,6}$/).optional(),
  takeOverFromShiftId: z.string().optional(),
  notes: z.string().max(300).optional(),
});

router.post("/open", requirePermission("shift.use"), async (req, res) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { businessId, userId } = req.auth!;
  const { openingFloat, pin, takeOverFromShiftId, notes } = parsed.data;

  try {
    const me = await prisma.user.findFirst({ where: { id: userId, businessId } });
    if (!me || !me.isActive) return res.status(403).json({ error: "Account not active" });
    if (needsPin(me.role)) await verifyOwnPin(me, pin);

    const shift = await createShift({ businessId, userId, openedById: null, openingFloat, takeOverFromShiftId, notes });
    await recordAudit({
      businessId, userId, action: "SHIFT_OPENED", entity: "Shift", entityId: shift.id,
      metadata: { openingFloat, handoverDifference: num(shift.handoverDifference) },
    });
    const names = await namesFor([userId]);
    return res.status(201).json({ shift: serialize(shift, names) });
  } catch (err: any) {
    const mapped = mapOpenError(err, res);
    if (mapped) return mapped;
    throw err;
  }
});

// ---- GET /shifts/cashiers ---- who a manager can open a shift for
router.get("/cashiers", requirePermission("shift.open_for"), async (req, res) => {
  const { businessId } = req.auth!;
  const [cashiers, open] = await Promise.all([
    prisma.user.findMany({ where: { businessId, role: "CASHIER", isActive: true }, select: { id: true, name: true, pinHash: true } }),
    prisma.shift.findMany({ where: { businessId, status: "OPEN" } }),
  ]);
  const openBy = new Set((open as any[]).map((s) => s.userId));
  return res.json({
    cashiers: (cashiers as any[]).map((c) => ({ id: c.id, name: c.name, hasPin: !!c.pinHash, hasOpenShift: openBy.has(c.id) })),
  });
});

// ---- POST /shifts/open-for ---- a manager opens a cashier's shift (no PIN needed)
const openForSchema = z.object({
  userId: z.string(),
  openingFloat: z.number().min(0).max(100_000_000),
  takeOverFromShiftId: z.string().optional(),
  notes: z.string().max(300).optional(),
});

router.post("/open-for", requirePermission("shift.open_for"), async (req, res) => {
  const parsed = openForSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { businessId, userId: managerId } = req.auth!;
  const { userId, openingFloat, takeOverFromShiftId, notes } = parsed.data;

  const target = await prisma.user.findFirst({ where: { id: userId, businessId } });
  if (!target || !target.isActive) return res.status(404).json({ error: "Cashier not found" });
  if (target.role !== "CASHIER") return res.status(400).json({ error: "You can only open a shift for a cashier." });

  try {
    const shift = await createShift({ businessId, userId, openedById: managerId, openingFloat, takeOverFromShiftId, notes });
    await recordAudit({
      businessId, userId: managerId, action: "SHIFT_OPENED_FOR", entity: "Shift", entityId: shift.id,
      metadata: { cashierId: userId, openingFloat, handoverDifference: num(shift.handoverDifference) },
    });
    const names = await namesFor([userId, managerId]);
    return res.status(201).json({ shift: serialize(shift, names) });
  } catch (err: any) {
    const mapped = mapOpenError(err, res);
    if (mapped) return mapped;
    throw err;
  }
});

// ---- POST /shifts/close ---- count the drawer and hand over
const closeSchema = z.object({
  countedCash: z.number().min(0).max(100_000_000),
  notes: z.string().max(300).optional(),
});

router.post("/close", requirePermission("shift.use"), async (req, res) => {
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { businessId, userId } = req.auth!;

  const shift = await prisma.shift.findFirst({ where: { businessId, userId, status: "OPEN" } });
  if (!shift) return res.status(409).json({ error: "You don't have an open shift." });

  // Tabs a cashier opened must be settled or handed over before the drawer is counted.
  const openTabs = await prisma.order.count({ where: { businessId, status: "OPEN", createdById: userId } });
  if (openTabs > 0) {
    return res.status(409).json({
      error: `You still have ${openTabs} open tab${openTabs === 1 ? "" : "s"}. Settle them before closing your shift.`,
      code: "OPEN_TABS",
    });
  }

  const now = new Date();
  const f = await shiftFigures(prisma, businessId, userId, shift.openedAt, now);
  const expected = expectedShiftCash(Number(shift.openingFloat), f.cash);
  const { variance, kind } = shiftVariance(parsed.data.countedCash, expected);

  // Claim the close so a double-click can't close it twice.
  const claimed = await prisma.shift.updateMany({
    where: { id: shift.id, status: "OPEN" },
    data: {
      status: "CLOSED", closedAt: now, expectedCash: expected, countedCash: parsed.data.countedCash,
      variance, closeNotes: parsed.data.notes, salesCount: f.count, salesTotal: f.total,
    },
  });
  if (claimed.count !== 1) return res.status(409).json({ error: "This shift was already closed." });

  await recordAudit({
    businessId, userId, action: "SHIFT_CLOSED", entity: "Shift", entityId: shift.id,
    metadata: { expected, counted: parsed.data.countedCash, variance },
  });

  const closed = await prisma.shift.findFirstOrThrow({ where: { id: shift.id } });
  const names = await namesFor([userId]);
  return res.json({ shift: serialize(closed, names), kind, byMethod: f.totals });
});

// ---- GET /shifts ---- history for managers
router.get("/", requirePermission("shift.view"), async (req, res) => {
  const { businessId } = req.auth!;
  const shifts = await prisma.shift.findMany({
    where: { businessId, ...(req.query.userId ? { userId: String(req.query.userId) } : {}) },
    orderBy: { openedAt: "desc" },
    take: 100,
  });
  const names = await namesFor(shifts.flatMap((s: any) => [s.userId, s.openedById]));
  return res.json({ shifts: shifts.map((s: any) => serialize(s, names)) });
});

// ---- PUT /shifts/settings ---- Owner only
router.put("/settings", authorize("OWNER"), async (req, res) => {
  const parsed = z.object({ requireShift: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  await prisma.business.update({ where: { id: req.auth!.businessId }, data: { requireShift: parsed.data.requireShift } });
  await recordAudit({
    businessId: req.auth!.businessId, userId: req.auth!.userId, action: "SHIFT_SETTING_CHANGED",
    entity: "Business", entityId: req.auth!.businessId, metadata: parsed.data,
  });
  return res.json({ requireShift: parsed.data.requireShift });
});

export default router;
