import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";

const router = Router();
router.use(authenticate);


// Outstanding balance is always computed from purchases/payments — never
// stored — so it can't drift out of sync with the underlying records.
function outstandingBalance(purchases: { totalCost: Prisma.Decimal | number; amountPaid: Prisma.Decimal | number }[]): number {
  return purchases.reduce((sum: number, p) => sum + (Number(p.totalCost) - Number(p.amountPaid)), 0);
}

// ---- GET /suppliers ---- search by name/phone
router.get("/", requirePermission("suppliers.view"), async (req, res) => {
  const { search } = req.query;
  const where: any = { businessId: req.auth!.businessId };
  if (search) {
    const term = String(search);
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { phone: { contains: term, mode: "insensitive" } },
    ];
  }

  const suppliers = await prisma.supplier.findMany({
    where,
    include: { purchases: { select: { totalCost: true, amountPaid: true } } },
    orderBy: { name: "asc" },
  });

  return res.json({
    suppliers: suppliers.map(({ purchases, ...s }) => ({
      ...s,
      outstandingBalance: outstandingBalance(purchases),
    })),
  });
});

// ---- GET /suppliers/:id ---- includes purchase history + balance
router.get("/:id", requirePermission("suppliers.view"), async (req, res) => {
  const supplier = await prisma.supplier.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
    include: {
      purchases: {
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, totalCost: true, amountPaid: true, paymentStatus: true, createdAt: true },
      },
    },
  });
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });

  return res.json({
    supplier: { ...supplier, outstandingBalance: outstandingBalance(supplier.purchases) },
  });
});

// ---- POST /suppliers ----
const createSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

router.post("/", requirePermission("suppliers.manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const supplier = await prisma.supplier.create({
    data: { businessId: req.auth!.businessId, ...parsed.data },
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "SUPPLIER_CREATED",
    entity: "Supplier",
    entityId: supplier.id,
  });

  return res.status(201).json({ supplier });
});

// ---- PATCH /suppliers/:id ----
const updateSchema = createSchema.partial();

router.patch("/:id", requirePermission("suppliers.manage"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const supplier = await prisma.supplier.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
  });
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });

  const updated = await prisma.supplier.update({ where: { id: supplier.id }, data: parsed.data });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "SUPPLIER_UPDATED",
    entity: "Supplier",
    entityId: updated.id,
    metadata: parsed.data,
  });

  return res.json({ supplier: updated });
});

// ---- DELETE /suppliers/:id ----
router.delete("/:id", requirePermission("suppliers.manage"), async (req, res) => {
  const supplier = await prisma.supplier.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
  });
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });

  const purchaseCount = await prisma.purchase.count({ where: { supplierId: supplier.id } });
  if (purchaseCount > 0) {
    return res.status(409).json({ error: `Cannot delete: supplier has ${purchaseCount} purchase(s) on record` });
  }

  await prisma.supplier.delete({ where: { id: supplier.id } });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "SUPPLIER_DELETED",
    entity: "Supplier",
    entityId: supplier.id,
  });

  return res.status(204).send();
});

export default router;
