import { Router } from "express";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { resolveDateRange } from "../utils/dateRange";
import { sendCsv } from "../utils/csv";

const router = Router();
router.use(authenticate);

// Read-only by design: there is deliberately no route anywhere in the API
// that edits or deletes an audit record, so ordinary users can't erase history.

// ---- GET /audit-logs ----
// Filters: userId, action, entity, entityId, and a date range
// (?range=today|week|month|year, or ?from=YYYY-MM-DD&to=YYYY-MM-DD).
// Paging: ?limit (default 100, max 500) & ?page. Add &format=csv to download.
router.get("/", requirePermission("audit.view"), async (req, res) => {
  const { userId, action, entity, entityId, format } = req.query;
  const where: any = { businessId: req.auth!.businessId };
  if (userId) where.userId = String(userId);
  if (action) where.action = String(action);
  if (entity) where.entity = String(entity);
  if (entityId) where.entityId = String(entityId);

  if (req.query.range || req.query.from || req.query.to) {
    try {
      const range = resolveDateRange(
        { range: req.query.range ?? "custom", from: req.query.from, to: req.query.to },
        "month"
      );
      where.createdAt = { gte: range.from, lte: range.to };
    } catch {
      return res.status(400).json({
        error: "Invalid date range. Use range=today|week|month|year, or from and to (YYYY-MM-DD).",
      });
    }
  }

  const csv = format === "csv";
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), csv ? 5000 : 500);
  const page = Math.max(Number(req.query.page) || 1, 1);

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
      orderBy: { createdAt: "desc" },
      skip: csv ? 0 : (page - 1) * limit,
      take: limit,
    }),
  ]);

  if (csv) {
    return sendCsv(
      res,
      `audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
      logs.map((l) => ({
        date: l.createdAt,
        user: l.user?.name ?? "",
        role: l.user?.role ?? "",
        action: l.action,
        entity: l.entity,
        entityId: l.entityId ?? "",
        details: l.metadata ? JSON.stringify(l.metadata) : "",
      }))
    );
  }

  return res.json({ total, page, limit, logs });
});

// ---- GET /audit-logs/actions ---- distinct action names, handy for a filter dropdown
router.get("/actions", requirePermission("audit.view"), async (req, res) => {
  const rows = await prisma.auditLog.findMany({
    where: { businessId: req.auth!.businessId },
    distinct: ["action"],
    select: { action: true },
    orderBy: { action: "asc" },
  });
  return res.json({ actions: rows.map((r) => r.action) });
});

export default router;
