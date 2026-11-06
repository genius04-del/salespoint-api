import { Router, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, authorize, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import {
  COUNTED_METHODS,
  buildExpected,
  gatherDayFigures,
  postVarianceEntries,
  reconcile,
  round2,
  DayFigures,
} from "../services/dayClose";
import { countPendingSales, getDeductionState } from "../services/stockDeduction";

const router = Router();
router.use(authenticate);

// A small error type so business-rule failures inside a transaction can carry
// their HTTP status and body out to the handler (the transaction rolls back).
class HttpError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(String(body.error ?? "error"));
  }
}

function sendError(res: Response, err: unknown) {
  if (err instanceof HttpError) return res.status(err.status).json(err.body);
  throw err;
}

// Serialises "open day" / "close day" per business so two people clicking at
// once can't create two open days or double-close one.
async function lockBusiness(tx: Prisma.TransactionClient, businessId: string) {
  await tx.$queryRaw`SELECT id FROM businesses WHERE id = ${businessId} FOR UPDATE`;
}

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? null : Number(d));

// Notes and coins counted: { "50": 4, "0.5": 2 } = four GH₵50 notes, two 50p coins.
const denominationsSchema = z.record(z.string().regex(/^\d+(\.\d{1,2})?$/), z.number().int().min(0).max(100000));
const denominationTotal = (d: Record<string, number>) =>
  round2(Object.entries(d).reduce((sum, [value, count]) => sum + Number(value) * count, 0));
const cleanDenominations = (d?: Record<string, number>) => {
  if (!d) return undefined;
  const kept = Object.fromEntries(Object.entries(d).filter(([, n]) => n > 0));
  return Object.keys(kept).length > 0 ? kept : undefined;
};

async function userNames(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (unique.length === 0) return new Map<string, string>();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map<string, string>((users as { id: string; name: string }[]).map((u) => [u.id, u.name]));
}

function serializeDay(day: any, names: Map<string, string>) {
  return {
    id: day.id,
    number: day.number ?? 0,
    posted: !!day.postedAt,
    postedAt: day.postedAt ?? null,
    postedBy: day.postedById ? names.get(day.postedById) ?? "Unknown" : null,
    status: day.status as "OPEN" | "CLOSED",
    openedAt: day.openedAt,
    openedBy: names.get(day.openedById) ?? "Unknown",
    openingFloat: num(day.openingFloat) ?? 0,
    openNotes: day.openNotes,
    openDenominations: (day.openDenominations as Record<string, number> | null) ?? null,
    closeDenominations: (day.closeDenominations as Record<string, number> | null) ?? null,
    closedAt: day.closedAt,
    closedBy: day.closedById ? names.get(day.closedById) ?? "Unknown" : null,
    closeNotes: day.closeNotes,
    totalExpected: num(day.totalExpected),
    totalCounted: num(day.totalCounted),
    totalVariance: num(day.totalVariance),
  };
}

function figuresPayload(figures: DayFigures, openingFloat: number) {
  return {
    orders: figures.orders,
    expected: buildExpected({
      openingFloat,
      salesByMethod: figures.salesByMethod,
      paidOutByMethod: figures.paidOutByMethod,
    }),
    paystack: figures.salesByMethod.PAYSTACK,
    byCashier: figures.byCashier,
  };
}

// ---- GET /days/current ----
// What the Day End page shows. Everyone with day access sees THEIR OWN sales
// for the day; only people who can close the day also see the whole shop's
// expected totals and every cashier's figures.
router.get("/current", requirePermission("day.view", "day.open", "day.close"), async (req, res) => {
  const { businessId, userId } = req.auth!;
  const canSeeAll = req.auth!.permissions.includes("day.close");

  const [business, day] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: { requireOpenDay: true, restaurantModeEnabled: true },
    }),
    prisma.businessDay.findFirst({ where: { businessId, status: "OPEN" } }),
  ]);

  if (!day) {
    const last = await prisma.businessDay.findFirst({
      where: { businessId, status: "CLOSED" },
      orderBy: { closedAt: "desc" },
      include: { counts: true },
    });
    const lastCash = last?.counts.find((c: { method: string }) => c.method === "CASH");
    return res.json({
      day: null,
      requireOpenDay: business?.requireOpenDay ?? false,
      suggestedFloat: lastCash ? Number(lastCash.counted) : 0,
      lastClosed: last ? { id: last.id, closedAt: last.closedAt, totalVariance: num(last.totalVariance) } : null,
    });
  }

  const now = new Date();
  const figures = await gatherDayFigures(prisma as unknown as Prisma.TransactionClient, businessId, day.openedAt, now);
  const names = await userNames([day.openedById, day.postedById]);
  const mine = figures.byCashier.find((c) => c.cashierId === userId);
  const openTabs = business?.restaurantModeEnabled
    ? await prisma.order.count({ where: { businessId, status: "OPEN" } })
    : 0;

  // Restaurants: after the finance posting the manager still has stock steps before closing.
  let stockSteps: { dayEnd: boolean; sales: number; pendingNumber: number | null; counted: boolean } | null = null;
  if (canSeeAll && business?.restaurantModeEnabled) {
    const db = prisma as unknown as Prisma.TransactionClient;
    const ded = await getDeductionState(db, businessId);
    stockSteps = {
      dayEnd: ded.dayEnd,
      sales: ded.dayEnd ? await countPendingSales(db, businessId, ded, now) : 0,
      pendingNumber: ded.pending?.number ?? null,
      counted: (await prisma.stockCount.count({ where: { businessId, status: { in: ["SUBMITTED", "APPROVED"] }, createdAt: { gte: day.openedAt } } })) > 0,
    };
  }
  const posting = day.postedAt
    ? ((await prisma.businessDayCount.findMany({ where: { dayId: day.id } })) as any[]).map((c) => ({
        method: c.method, expected: round2(Number(c.expected)), counted: round2(Number(c.counted)), variance: round2(Number(c.variance)),
      }))
    : null;

  return res.json({
    day: serializeDay(day, names),
    requireOpenDay: business?.requireOpenDay ?? false,
    stockSteps,
    posting,
    asOf: now,
    openTabs,
    mine: mine ?? { cashierId: userId, name: "You", orders: 0, totals: { CASH: 0, MOBILE_MONEY: 0, BANK_TRANSFER: 0, OTHER: 0, PAYSTACK: 0 } },
    ...(canSeeAll ? figuresPayload(figures, Number(day.openingFloat)) : {}),
  });
});

// ---- POST /days/open ----
const openSchema = z.object({
  openingFloat: z.number().min(0).default(0), // cash already in the drawer
  notes: z.string().max(500).optional(),
  denominations: denominationsSchema.optional(), // the notes and coins that make up the float
});

router.post("/open", requirePermission("day.open"), async (req, res) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { businessId, userId } = req.auth!;
  const openDenoms = cleanDenominations(parsed.data.denominations);
  if (openDenoms && Math.abs(denominationTotal(openDenoms) - parsed.data.openingFloat) > 0.005) {
    return res.status(400).json({ error: "The notes and coins you counted do not add up to the float." });
  }

  try {
    const day = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockBusiness(tx, businessId);
      const existing = await tx.businessDay.findFirst({ where: { businessId, status: "OPEN" } });
      if (existing) {
        throw new HttpError(409, { error: "A business day is already open. Close it before opening a new one.", code: "DAY_ALREADY_OPEN" });
      }
      const counter = await tx.business.update({
        where: { id: businessId },
        data: { dayCounter: { increment: 1 } },
        select: { dayCounter: true },
      });
      return tx.businessDay.create({
        data: {
          businessId,
          number: counter.dayCounter,
          openedById: userId,
          openingFloat: parsed.data.openingFloat,
          openNotes: parsed.data.notes?.trim() || null,
          ...(openDenoms ? { openDenominations: openDenoms } : {}),
        },
      });
    });

    await recordAudit({
      businessId,
      userId,
      action: "DAY_OPENED",
      entity: "BusinessDay",
      entityId: day.id,
      metadata: { openingFloat: parsed.data.openingFloat },
    });

    const names = await userNames([day.openedById]);
    return res.status(201).json({ day: serializeDay(day, names) });
  } catch (err) {
    return sendError(res, err);
  }
});

// ---- POST /days/post ---- the finance posting (cash-up)
// The manager sends what they physically counted per method. The server
// recomputes what was expected AT THIS MOMENT (never trusting a client figure),
// compares, and only closes if it balances — or if the manager explicitly
// accepts the difference with a written reason. Differences are posted to the
// ledger (Cash Over/Short) in the same transaction, so books and drawer agree.
const postSchema = z.object({
  counts: z
    .array(z.object({ method: z.enum(COUNTED_METHODS), counted: z.number().min(0) }))
    .max(COUNTED_METHODS.length),
  notes: z.string().max(1000).optional(),
  acceptVariance: z.boolean().default(false),
  denominations: denominationsSchema.optional(), // the notes and coins that make up the counted cash
});

router.post("/post", requirePermission("day.close"), async (req, res) => {
  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { counts, acceptVariance } = parsed.data;
  const notes = parsed.data.notes?.trim() || "";
  const { businessId, userId } = req.auth!;
  const closeDenoms = cleanDenominations(parsed.data.denominations);
  if (closeDenoms) {
    const cash = counts.find((c) => c.method === "CASH")?.counted ?? 0;
    if (Math.abs(denominationTotal(closeDenoms) - cash) > 0.005) {
      return res.status(400).json({ error: "The notes and coins you counted do not add up to the cash amount." });
    }
  }

  if (new Set(counts.map((c) => c.method)).size !== counts.length) {
    return res.status(400).json({ error: "Each payment method can only be counted once." });
  }

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockBusiness(tx, businessId);

      const day = await tx.businessDay.findFirst({ where: { businessId, status: "OPEN" } });
      if (!day) throw new HttpError(409, { error: "There is no open business day to post.", code: "NO_OPEN_DAY" });
      if (day.postedAt) throw new HttpError(409, { error: "The finance posting for this day is already saved.", code: "DAY_ALREADY_POSTED" });

      const openTabs = await tx.order.count({ where: { businessId, status: "OPEN" } });
      if (openTabs > 0) {
        throw new HttpError(409, {
          error: `${openTabs} table tab${openTabs === 1 ? " is" : "s are"} still open. Pay or cancel ${openTabs === 1 ? "it" : "them"} before the finance posting.`,
          code: "OPEN_TABS",
          openTabs,
        });
      }

      const closedAt = new Date();
      const figures = await gatherDayFigures(tx, businessId, day.openedAt, closedAt);
      const expected = buildExpected({
        openingFloat: Number(day.openingFloat),
        salesByMethod: figures.salesByMethod,
        paidOutByMethod: figures.paidOutByMethod,
      });
      const rec = reconcile(expected, counts);

      if (rec.missing.length > 0) {
        throw new HttpError(400, {
          error: `Enter the counted amount for: ${rec.missing.map((m) => m.replace(/_/g, " ").toLowerCase()).join(", ")}.`,
          code: "COUNT_MISSING",
          missing: rec.missing,
        });
      }

      if (!rec.balanced) {
        if (!acceptVariance) {
          throw new HttpError(409, {
            error: "The count does not match what the system expected. Review the differences, then confirm to close with them.",
            code: "VARIANCE_NOT_CONFIRMED",
            rows: rec.rows,
            totalVariance: rec.totalVariance,
          });
        }
        if (!notes) {
          throw new HttpError(400, {
            error: "Please write a short reason for the difference before closing.",
            code: "NOTE_REQUIRED",
          });
        }
      }

      const journalIds = await postVarianceEntries({
        tx,
        businessId,
        dayId: day.id,
        rows: rec.rows,
        createdById: userId,
        closedAt,
      });

      await tx.businessDayCount.createMany({
        data: rec.rows.map((r) => ({
          dayId: day.id,
          method: r.method,
          expected: r.expected,
          counted: r.counted,
          variance: r.variance,
          journalEntryId: journalIds[r.method] ?? null,
        })),
      });

      const closed = await tx.businessDay.update({
        where: { id: day.id },
        data: {
          postedAt: closedAt,
          postedById: userId,
          closeNotes: notes || null,
          ...(closeDenoms ? { closeDenominations: closeDenoms } : {}),
          totalExpected: rec.totalExpected,
          totalCounted: rec.totalCounted,
          totalVariance: rec.totalVariance,
        },
      });

      return { closed, rec, figures };
    });

    await recordAudit({
      businessId,
      userId,
      action: "DAY_POSTED",
      entity: "BusinessDay",
      entityId: result.closed.id,
      metadata: {
        totalExpected: result.rec.totalExpected,
        totalCounted: result.rec.totalCounted,
        totalVariance: result.rec.totalVariance,
        balanced: result.rec.balanced,
      },
    });

    const names = await userNames([result.closed.openedById, result.closed.postedById]);
    return res.json({
      day: serializeDay(result.closed, names),
      rows: result.rec.rows,
      balanced: result.rec.balanced,
      paystack: result.figures.salesByMethod.PAYSTACK,
      orders: result.figures.orders,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// ---- POST /days/close ---- close the day, last of all
// Only after the finance posting is saved, and (restaurants that deduct at day end)
// after the sales were deducted and uploaded. The daily stock count is advised, not forced.
router.post("/close", requirePermission("day.close"), async (req, res) => {
  const { businessId, userId } = req.auth!;
  const notes = typeof req.body?.notes === "string" ? req.body.notes.trim().slice(0, 500) : "";
  try {
    const closed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockBusiness(tx, businessId);
      const day = await tx.businessDay.findFirst({ where: { businessId, status: "OPEN" } });
      if (!day) throw new HttpError(409, { error: "There is no open business day to close.", code: "NO_OPEN_DAY" });
      if (!day.postedAt) throw new HttpError(409, { error: "Do the finance posting first. It counts the money so the cashiers can go.", code: "NOT_POSTED" });

      const openTabs = await tx.order.count({ where: { businessId, status: "OPEN" } });
      if (openTabs > 0) {
        throw new HttpError(409, { error: `${openTabs} table tab${openTabs === 1 ? " is" : "s are"} still open. Pay or cancel ${openTabs === 1 ? "it" : "them"} first.`, code: "OPEN_TABS", openTabs });
      }

      const ded = await getDeductionState(tx, businessId);
      if (ded.dayEnd) {
        if (ded.pending) {
          throw new HttpError(409, { error: `SD-${String(ded.pending.number).padStart(4, "0")} is waiting to be uploaded in Stock Adjustment.`, code: "STOCK_STEPS" });
        }
        const pending = await countPendingSales(tx, businessId, ded);
        if (pending > 0) {
          throw new HttpError(409, { error: `${pending} sale${pending === 1 ? " has" : "s have"} not been deducted from stock yet. Use Deduct Sales first.`, code: "STOCK_STEPS" });
        }
      }

      return tx.businessDay.update({
        where: { id: day.id },
        data: { status: "CLOSED", closedAt: new Date(), closedById: userId, ...(notes ? { closeNotes: notes } : {}) },
      });
    });

    await recordAudit({ businessId, userId, action: "DAY_CLOSED", entity: "BusinessDay", entityId: closed.id });
    const names = await userNames([closed.openedById, closed.postedById, closed.closedById]);
    return res.json({ day: serializeDay(closed, names) });
  } catch (err) {
    return sendError(res, err);
  }
});

// ---- PUT /days/settings ---- Owner only
router.put("/settings", authorize("OWNER"), async (req, res) => {
  const parsed = z.object({ requireOpenDay: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { businessId, userId } = req.auth!;

  await prisma.business.update({ where: { id: businessId }, data: { requireOpenDay: parsed.data.requireOpenDay } });
  await recordAudit({
    businessId,
    userId,
    action: "BUSINESS_SETTINGS_UPDATED",
    entity: "Business",
    entityId: businessId,
    metadata: { requireOpenDay: parsed.data.requireOpenDay },
  });
  return res.json({ requireOpenDay: parsed.data.requireOpenDay });
});

// ---- GET /days ---- history (managers / finance only — it shows every variance)
router.get("/", requirePermission("day.close", "finance.view"), async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const days = await prisma.businessDay.findMany({
    where: { businessId: req.auth!.businessId },
    orderBy: { openedAt: "desc" },
    take: limit,
  });
  const names = await userNames(days.flatMap((d: any) => [d.openedById, d.postedById, d.closedById]));
  return res.json({ days: days.map((d: any) => serializeDay(d, names)) });
});

// ---- GET /days/:id ---- one past day, with its counts and per-cashier figures
router.get("/:id", requirePermission("day.close", "finance.view"), async (req, res) => {
  const { businessId } = req.auth!;
  const day = await prisma.businessDay.findFirst({
    where: { id: req.params.id, businessId },
    include: { counts: true },
  });
  if (!day) return res.status(404).json({ error: "Business day not found" });

  const to = day.postedAt ?? day.closedAt ?? new Date();
  const figures = await gatherDayFigures(prisma as unknown as Prisma.TransactionClient, businessId, day.openedAt, to);
  const names = await userNames([day.openedById, day.postedById, day.closedById]);

  const order = new Map<string, number>(COUNTED_METHODS.map((m, i) => [m as string, i]));
  const counts = [...day.counts]
    .sort((a: any, b: any) => (order.get(a.method) ?? 9) - (order.get(b.method) ?? 9))
    .map((c: any) => ({
      method: c.method,
      expected: round2(Number(c.expected)),
      counted: round2(Number(c.counted)),
      variance: round2(Number(c.variance)),
      posted: !!c.journalEntryId,
    }));

  return res.json({
    day: serializeDay(day, names),
    counts,
    orders: figures.orders,
    paystack: figures.salesByMethod.PAYSTACK,
    byCashier: figures.byCashier,
  });
});

export default router;
