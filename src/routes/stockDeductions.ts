import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import { applyUsage, computeUsage, getDeductionState, pendingFrom, type UsageLine } from "../services/stockDeduction";

// The flow, for restaurants that deduct at day end:
//   1. Deduct Sales      -> works out what the sales used and freezes it as a PENDING run
//                           (stock is NOT touched). The person downloads it as a file.
//   2. Stock Adjustment  -> the file is uploaded; the server checks it against the run and
//                           only then takes the stock off (APPLIED).
//   3. Daily stock count, then Day End.
const router = Router();
router.use(authenticate);

const CREATE = ["stock.manage", "stock.approve", "day.close"] as const;
const APPLY = ["stock.manage", "stock.approve"] as const;
const ref = (n: number) => `SD-${String(n).padStart(4, "0")}`;

const serialize = (r: any, names: Map<string, string>) => ({
  id: r.id,
  number: r.number,
  status: r.status as "PENDING" | "APPLIED",
  fromAt: r.fromAt,
  toAt: r.toAt,
  salesCount: r.salesCount,
  by: names.get(r.createdById) ?? "Unknown",
  appliedBy: r.appliedById ? names.get(r.appliedById) ?? "Unknown" : null,
  appliedAt: r.appliedAt ?? null,
  lines: r.lines as UsageLine[],
});

// ---- GET /stock-deductions/preview ---- what the sales since the last run would use
router.get("/preview", requirePermission(...CREATE), async (req, res) => {
  const { businessId } = req.auth!;
  const db = prisma as unknown as Prisma.TransactionClient;
  const state = await getDeductionState(db, businessId);
  if (!state.dayEnd) return res.json({ enabled: false });

  const to = new Date();
  const from = pendingFrom(state);
  const [usage, openTabs] = await Promise.all([computeUsage(db, businessId, from, to), prisma.order.count({ where: { businessId, status: "OPEN" } })]);
  return res.json({
    enabled: true,
    from,
    to,
    openTabs,
    pending: state.pending ? { id: state.pending.id, number: state.pending.number } : null,
    ...usage,
  });
});

// ---- POST /stock-deductions ---- work out the run and freeze it (stock untouched)
router.post("/", requirePermission(...CREATE), async (req, res) => {
  const { businessId, userId } = req.auth!;

  const result = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM businesses WHERE id = ${businessId} FOR UPDATE`;
      const state = await getDeductionState(tx, businessId);
      if (!state.dayEnd) return { status: 409, body: { error: "Sales are deducted as they happen in this business, so there is nothing to run." } };
      if (state.pending) {
        return { status: 409, body: { error: `${ref(state.pending.number)} is still waiting. Upload it in Stock Adjustment, or cancel it here, before making another.`, code: "DEDUCTION_PENDING" } };
      }

      const to = new Date();
      const from = pendingFrom(state);
      const usage = await computeUsage(tx, businessId, from, to);
      if (usage.salesCount === 0) return { status: 409, body: { error: "There are no new sales to deduct." } };

      const counter = await tx.business.update({ where: { id: businessId }, data: { deductionCounter: { increment: 1 } }, select: { deductionCounter: true } });
      const row = await tx.stockDeduction.create({
        data: { businessId, number: counter.deductionCounter, fromAt: from, toAt: to, salesCount: usage.salesCount, lines: usage.lines as any, status: "PENDING", createdById: userId },
      });
      return { status: 201, body: { deduction: serialize(row, new Map()) } };
    },
    { timeout: 60000 }
  );

  if (result.status === 201) {
    const d = (result.body as any).deduction;
    await recordAudit({ businessId, userId, action: "STOCK_DEDUCTION_CREATED", entity: "StockDeduction", entityId: d.id, metadata: { number: d.number, salesCount: d.salesCount } });
  }
  return res.status(result.status).json(result.body);
});

// ---- POST /stock-deductions/apply ---- the uploaded file: check it, then take the stock off
const applySchema = z.object({
  number: z.number().int().positive(),
  lines: z.array(z.object({ kind: z.enum(["INGREDIENT", "PRODUCT"]), id: z.string(), quantity: z.number() })).min(1),
});

router.post("/apply", requirePermission(...APPLY), async (req, res) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "That file could not be read. Download it again from Deduct Sales." });
  const { businessId, userId } = req.auth!;

  const result = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM businesses WHERE id = ${businessId} FOR UPDATE`;
      const row = await tx.stockDeduction.findFirst({ where: { businessId, number: parsed.data.number } });
      if (!row) return { status: 404, body: { error: `${ref(parsed.data.number)} was not found in this business. Is the file from another branch?` } };
      if (row.status === "APPLIED") return { status: 409, body: { error: `${ref(row.number)} was already saved. A file can only be uploaded once.`, code: "ALREADY_APPLIED" } };

      // The file must say exactly what the run says: same items, same quantities.
      const stored = new Map<string, UsageLine>((row.lines as unknown as UsageLine[]).map((l) => [`${l.kind}:${l.id}`, l]));
      const sent = new Map(parsed.data.lines.map((l) => [`${l.kind}:${l.id}`, l.quantity]));
      const problems: string[] = [];
      for (const [key, line] of stored) {
        const got = sent.get(key);
        if (got === undefined) problems.push(`${line.name} is missing from the file`);
        else if (Math.abs(got - line.quantity) > 0.0005) problems.push(`${line.name}: the file says ${got}, the deduction says ${line.quantity}`);
      }
      for (const key of sent.keys()) if (!stored.has(key)) problems.push("The file has an item that is not in the deduction");
      if (problems.length > 0) {
        return { status: 400, body: { error: `This file does not match ${ref(row.number)} (${problems.slice(0, 3).join("; ")}). Download it again and upload it without changing it.`, problems, code: "FILE_MISMATCH" } };
      }

      await applyUsage({ tx, businessId, userId, lines: row.lines as unknown as UsageLine[], reason: `Sales deduction ${ref(row.number)}`, reference: row.id });
      const done = await tx.stockDeduction.update({ where: { id: row.id }, data: { status: "APPLIED", appliedAt: new Date(), appliedById: userId } });
      return { status: 200, body: { deduction: serialize(done, new Map()) } };
    },
    { timeout: 60000 }
  );

  if (result.status === 200) {
    const d = (result.body as any).deduction;
    await recordAudit({ businessId, userId, action: "SALES_DEDUCTED_FROM_STOCK", entity: "StockDeduction", entityId: d.id, metadata: { number: d.number, salesCount: d.salesCount } });
  }
  return res.status(result.status).json(result.body);
});

// ---- DELETE /stock-deductions/:id ---- throw away a run nobody uploaded; its sales become pending again
router.delete("/:id", requirePermission(...CREATE), async (req, res) => {
  const { businessId, userId } = req.auth!;
  const row = await prisma.stockDeduction.findFirst({ where: { id: req.params.id, businessId } });
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.status !== "PENDING") return res.status(409).json({ error: "This one has already been saved to stock and cannot be removed." });
  await prisma.stockDeduction.delete({ where: { id: row.id } });
  await recordAudit({ businessId, userId, action: "STOCK_DEDUCTION_CANCELLED", entity: "StockDeduction", entityId: row.id, metadata: { number: row.number } });
  return res.json({ message: "Cancelled. Those sales will be picked up by the next deduction." });
});

// ---- GET /stock-deductions ---- history and what is waiting
router.get("/", requirePermission(...CREATE, "stock.view"), async (req, res) => {
  const rows = await prisma.stockDeduction.findMany({ where: { businessId: req.auth!.businessId }, orderBy: { toAt: "desc" }, take: 30 });
  const ids = [...new Set(rows.flatMap((r: any) => [r.createdById, r.appliedById]).filter(Boolean) as string[])];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const names = new Map<string, string>((users as any[]).map((u) => [u.id, u.name]));
  return res.json({ deductions: rows.map((r: any) => serialize(r, names)) });
});

export default router;
