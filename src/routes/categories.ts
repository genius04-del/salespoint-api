import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";

const router = Router();
router.use(authenticate);


// ---- GET /categories ----
router.get("/", async (req, res) => {
  const categories = await prisma.category.findMany({
    where: { businessId: req.auth!.businessId },
    orderBy: { name: "asc" },
  });
  return res.json({ categories });
});

// ---- POST /categories ----
const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

router.post("/", requirePermission("products.manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.category.findFirst({
    where: { businessId: req.auth!.businessId, name: parsed.data.name },
  });
  if (existing) return res.status(409).json({ error: "A category with this name already exists" });

  const category = await prisma.category.create({
    data: { businessId: req.auth!.businessId, ...parsed.data },
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "CATEGORY_CREATED",
    entity: "Category",
    entityId: category.id,
  });

  return res.status(201).json({ category });
});

// ---- PATCH /categories/:id ----
const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});

router.patch("/:id", requirePermission("products.manage"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const category = await prisma.category.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
  });
  if (!category) return res.status(404).json({ error: "Category not found" });

  const updated = await prisma.category.update({
    where: { id: category.id },
    data: parsed.data,
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "CATEGORY_UPDATED",
    entity: "Category",
    entityId: updated.id,
    metadata: parsed.data,
  });

  return res.json({ category: updated });
});

// ---- DELETE /categories/:id ----
// Blocked if products still reference it — reassign or deactivate them first.
router.delete("/:id", requirePermission("products.manage"), async (req, res) => {
  const category = await prisma.category.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
  });
  if (!category) return res.status(404).json({ error: "Category not found" });

  const productCount = await prisma.product.count({ where: { categoryId: category.id } });
  if (productCount > 0) {
    return res.status(409).json({
      error: `Cannot delete: ${productCount} product(s) still use this category. Reassign them first.`,
    });
  }

  await prisma.category.delete({ where: { id: category.id } });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "CATEGORY_DELETED",
    entity: "Category",
    entityId: category.id,
  });

  return res.status(204).send();
});

export default router;
