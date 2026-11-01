import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";

const router = Router();
router.use(authenticate);

// Cashiers need customers for POS lookups (rule: Cashier role has Customers access).

// ---- GET /customers ---- search by name/phone
router.get("/", requirePermission("customers.manage"), async (req, res) => {
  const { search } = req.query;
  const where: any = { businessId: req.auth!.businessId };
  if (search) {
    const term = String(search);
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { phone: { contains: term, mode: "insensitive" } },
    ];
  }
  const customers = await prisma.customer.findMany({ where, orderBy: { name: "asc" } });
  return res.json({ customers });
});

// ---- GET /customers/:id ---- includes basic purchase history
router.get("/:id", requirePermission("customers.manage"), async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
    include: {
      sales: {
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, receiptNumber: true, total: true, status: true, createdAt: true },
      },
    },
  });
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  return res.json({ customer });
});

// ---- POST /customers ----
const createSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

router.post("/", requirePermission("customers.manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const customer = await prisma.customer.create({
    data: { businessId: req.auth!.businessId, ...parsed.data },
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "CUSTOMER_CREATED",
    entity: "Customer",
    entityId: customer.id,
  });

  return res.status(201).json({ customer });
});

// ---- PATCH /customers/:id ----
const updateSchema = createSchema.partial();

router.patch("/:id", requirePermission("customers.manage"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
  });
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  const updated = await prisma.customer.update({ where: { id: customer.id }, data: parsed.data });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "CUSTOMER_UPDATED",
    entity: "Customer",
    entityId: updated.id,
    metadata: parsed.data,
  });

  return res.json({ customer: updated });
});

// ---- DELETE /customers/:id ----
// Blocked if the customer has any sales history — that history must stay auditable.
router.delete("/:id", requirePermission("customers.manage"), async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
  });
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  const saleCount = await prisma.sale.count({ where: { customerId: customer.id } });
  if (saleCount > 0) {
    return res.status(409).json({ error: `Cannot delete: customer has ${saleCount} sale(s) on record` });
  }

  await prisma.customer.delete({ where: { id: customer.id } });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "CUSTOMER_DELETED",
    entity: "Customer",
    entityId: customer.id,
  });

  return res.status(204).send();
});

export default router;
