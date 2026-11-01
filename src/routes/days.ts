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

async function userNames(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (unique.length === 0) return new Map<string, string>();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map<string, string>((users as { id: string; name: string }[]).map((u) => [u.id, u.name]));
}

function serializeDay(day: any, names: Map<string, string>) {
  return {
    id: day.id,
    status: day.status as "OPEN" | "CLOSED",
    openedAt: day.openedAt,
    openedBy: names.get(day.openedById) ?? "Unknown",
    openingFloat: num(day.openingFloat) ?? 0,
    openNotes: day.openNotes,
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
  const names = await userNames([day.openedById]);
  const mine = figures.byCashier.find((c) => c.cashierId === userId);
  const openTabs = business?.restaurantModeEnabled
    ? await prisma.order.count({ where: { businessId, status: "OPEN" } })
    : 0;

  return res.json({
    day: serializeDay(day, names),
    requireOpenDay: business?.requireOpenDay ?? false,
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
});

router.post("/open", requirePermission("day.open"), async (req, res) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { businessId, userId } = req.auth!;

  try {
    const day = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockBusiness(tx, businessId);
      const existing = await tx.businessDay.findFirst({ where: { businessId, status: "OPEN" } });
      if (existing) {
        throw new HttpError(409, { error: "A business day is already open. Close it before opening a new one.", code: "DAY_ALREADY_OPEN" });
      }
      return tx.businessDay.create({
        data: {
          businessId,
          openedById: userId,
          openingFloat: parsed.data.openingFloat,
          openNotes: parsed.data.notes?.trim() || null,
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

// ---- POST /days/close ---- the cash-up
// The manager sends what they physically counted per method. The server
// recomputes what was expected AT THIS MOMENT (never trusting a client figure),
// compares, and only closes if it balances — or if the manager explicitly
// accepts the difference with a written reason. Differences are posted to the
// ledger (Cash Over/Short) in the same transaction, so books and drawer agree.
const closeSchema = z.object({
  counts: z
    .array(z.object({ method: z.enum(COUNTED_METHODS), counted: z.number().min(0) }))
    .max(COUNTED_METHODS.length),
  notes: z.string().max(1000).optional(),
  acceptVariance: z.boolean().default(false),
});

router.post("/close", requirePermission("day.close"), async (req, res) => {
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { counts, acceptVariance } = parsed.data;
  const notes = parsed.data.notes?.trim() || "";
  const { businessId, userId } = req.auth!;

  if (new Set(counts.map((c) => c.method)).size !== counts.length) {
    return res.status(400).json({ error: "Each payment method can only be counted once." });
  }

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockBusiness(tx, businessId);

      const day = await tx.businessDay.findFirst({ where: { businessId, status: "OPEN" } });
      if (!day) throw new HttpError(409, { error: "There is no open business day to close.", code: "NO_OPEN_DAY" });

      const openTabs = await tx.order.count({ where: { businessId, status: "OPEN" } });
      if (openTabs > 0) {
        throw new HttpError(409, {
          error: `${openTabs} table tab${openTabs === 1 ? " is" : "s are"} still open. Pay or cancel ${openTabs === 1 ? "it" : "them"} before closing the day.`,
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
          status: "CLOSED",
          closedAt,
          closedById: userId,
          closeNotes: notes || null,
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
      action: "DAY_CLOSED",
      entity: "BusinessDay",
      entityId: result.closed.id,
      metadata: {
        totalExpected: result.rec.totalExpected,
        totalCounted: result.rec.totalCounted,
        totalVariance: result.rec.totalVariance,
        balanced: result.rec.balanced,
      },
    });

    const names = await userNames([result.closed.openedById, result.closed.closedById]);
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
  const names = await userNames(days.flatMap((d: any) => [d.openedById, d.closedById]));
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

  const to = day.closedAt ?? new Date();
  const figures = await gatherDayFigures(prisma as unknown as Prisma.TransactionClient, businessId, day.openedAt, to);
  const names = await userNames([day.openedById, day.closedById]);

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
