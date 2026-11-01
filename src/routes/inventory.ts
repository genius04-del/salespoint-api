import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import { applyInventoryMovement } from "../services/inventory";

const router = Router();
router.use(authenticate);


// Movement types a user is allowed to record by hand here.
// PURCHASE and SALE will be created automatically by the Purchases and
// POS modules in later phases, not through this manual endpoint.
const MANUAL_TYPES = ["ADJUSTMENT", "DAMAGE", "RETURN", "OPENING_STOCK", "TRANSFER"] as const;

// ---- POST /inventory/movements ----
const createSchema = z.object({
  productId: z.string(),
  type: z.enum(MANUAL_TYPES),
  quantityChange: z.number().int().refine((n) => n !== 0, "quantityChange cannot be 0"),
  reason: z.string().min(1),
});

router.post("/movements", requirePermission("inventory.manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      return applyInventoryMovement({
        tx,
        businessId: req.auth!.businessId,
        productId: parsed.data.productId,
        type: parsed.data.type,
        quantityChange: parsed.data.quantityChange,
        reason: parsed.data.reason,
        userId: req.auth!.userId,
      });
    });

    await recordAudit({
      businessId: req.auth!.businessId,
      userId: req.auth!.userId,
      action: "STOCK_ADJUSTMENT",
      entity: "Product",
      entityId: parsed.data.productId,
      metadata: { type: parsed.data.type, quantityChange: parsed.data.quantityChange, reason: parsed.data.reason },
    });

    return res.status(201).json(result);
  } catch (err: any) {
    if (err.message === "PRODUCT_NOT_FOUND") {
      return res.status(404).json({ error: "Product not found" });
    }
    if (err.message === "INSUFFICIENT_STOCK") {
      return res.status(409).json({ error: "This movement would take stock below zero" });
    }
    throw err;
  }
});

// ---- GET /inventory/movements ----
// Query params: productId (optional filter)
router.get("/movements", requirePermission("inventory.view"), async (req, res) => {
  const { productId } = req.query;
  const movements = await prisma.inventoryMovement.findMany({
    where: {
      businessId: req.auth!.businessId,
      ...(productId ? { productId: String(productId) } : {}),
    },
    include: { product: { select: { id: true, name: true, sku: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return res.json({ movements });
});

// ---- GET /inventory/low-stock ----
router.get("/low-stock", requirePermission("inventory.view"), async (req, res) => {
  // Prisma can't compare two columns in a `where` directly, so filter in SQL.
  const products = await prisma.$queryRaw`
    SELECT id, name, sku, "currentQuantity", "minStockLevel"
    FROM products
    WHERE "businessId" = ${req.auth!.businessId}
      AND "isActive" = true
      AND "currentQuantity" <= "minStockLevel"
      AND NOT EXISTS (SELECT 1 FROM recipe_lines r WHERE r."productId" = products.id)
    ORDER BY "currentQuantity" ASC
  `;
  return res.json({ products });
});

export default router;
