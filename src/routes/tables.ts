import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { requireRestaurantMode } from "../middleware/restaurantMode";
import { recordAudit } from "../utils/audit";

const router = Router();
router.use(authenticate, requireRestaurantMode);

// ---- GET /tables ----
router.get("/", requirePermission("sales.view", "sales.create"), async (req, res) => {
  const tables = await prisma.table.findMany({
    where: { businessId: req.auth!.businessId, isActive: true },
    orderBy: { name: "asc" },
  });
  return res.json({ tables });
});

// ---- POST /tables ----
const createSchema = z.object({
  name: z.string().min(1),
  capacity: z.number().int().positive().optional(),
});

router.post("/", requirePermission("tables.manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const table = await prisma.table.create({
      data: { businessId: req.auth!.businessId, ...parsed.data },
    });
    await recordAudit({
      businessId: req.auth!.businessId,
      userId: req.auth!.userId,
      action: "TABLE_CREATED",
      entity: "Table",
      entityId: table.id,
    });
    return res.status(201).json({ table });
  } catch (err: any) {
    if (err.code === "P2002") return res.status(409).json({ error: "A table with this name already exists" });
    throw err;
  }
});

// ---- PATCH /tables/:id ----
const updateSchema = z.object({
  name: z.string().min(1).optional(),
  capacity: z.number().int().positive().nullable().optional(),
  status: z.enum(["AVAILABLE", "OCCUPIED", "RESERVED", "NEEDS_CLEANING"]).optional(),
  isActive: z.boolean().optional(),
});

router.patch("/:id", requirePermission("tables.manage"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const table = await prisma.table.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
  });
  if (!table) return res.status(404).json({ error: "Table not found" });

  const updated = await prisma.table.update({ where: { id: table.id }, data: parsed.data });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "TABLE_UPDATED",
    entity: "Table",
    entityId: updated.id,
    metadata: parsed.data,
  });

  return res.json({ table: updated });
});

export default router;
