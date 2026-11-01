import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import { applyInventoryMovement } from "../services/inventory";
import { withRecipePortions } from "../services/productStock";

const router = Router();
router.use(authenticate);


// ---- GET /products ----
// Everyone in the business can read (cashiers need this for POS in Phase 3).
// Query params: search (name/sku/barcode), categoryId, includeInactive
router.get("/", async (req, res) => {
  const { search, categoryId, includeInactive } = req.query;

  const where: any = { businessId: req.auth!.businessId };
  if (!includeInactive) where.isActive = true;
  if (categoryId) where.categoryId = String(categoryId);
  if (search) {
    const term = String(search);
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { sku: { contains: term, mode: "insensitive" } },
      { barcode: { contains: term, mode: "insensitive" } },
    ];
  }

  const products = await prisma.product.findMany({
    where,
    include: { category: { select: { id: true, name: true } } },
    orderBy: { name: "asc" },
  });

  // Dishes with a recipe report how many portions their ingredients allow.
  return res.json({ products: await withRecipePortions(prisma, products) });
});

// ---- GET /products/:id ----
router.get("/:id", async (req, res) => {
  const product = await prisma.product.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
    include: { category: { select: { id: true, name: true } } },
  });
  if (!product) return res.status(404).json({ error: "Product not found" });
  const [annotated] = await withRecipePortions(prisma, [product]);
  return res.json({ product: annotated });
});

// ---- POST /products ----
const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  categoryId: z.string().optional(),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  unit: z.string().default("unit"),
  costPrice: z.number().min(0).default(0),
  sellingPrice: z.number().min(0),
  minStockLevel: z.number().int().min(0).default(0),
  imageUrl: z.string().url().optional(),
  openingStock: z.number().int().min(0).default(0),
});

router.post("/", requirePermission("products.manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { openingStock, ...productData } = parsed.data;

  if (productData.categoryId) {
    const category = await prisma.category.findFirst({
      where: { id: productData.categoryId, businessId: req.auth!.businessId },
    });
    if (!category) return res.status(400).json({ error: "Category not found for this business" });
  }

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const product = await tx.product.create({
        data: {
          businessId: req.auth!.businessId,
          ...productData,
          currentQuantity: 0, // set for real just below, always via a movement
        },
      });

      if (openingStock > 0) {
        await applyInventoryMovement({
          tx,
          businessId: req.auth!.businessId,
          productId: product.id,
          type: "OPENING_STOCK",
          quantityChange: openingStock,
          reason: "Initial stock on product creation",
          userId: req.auth!.userId,
        });
      }

      return tx.product.findUniqueOrThrow({ where: { id: product.id } });
    });

    await recordAudit({
      businessId: req.auth!.businessId,
      userId: req.auth!.userId,
      action: "PRODUCT_CREATED",
      entity: "Product",
      entityId: result.id,
      metadata: { openingStock },
    });

    return res.status(201).json({ product: result });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "A product with this SKU or barcode already exists" });
    }
    throw err;
  }
});

// ---- PATCH /products/:id ----
// Note: currentQuantity is deliberately NOT editable here — stock changes
// only ever happen through /inventory/movements.
const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  categoryId: z.string().nullable().optional(),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  unit: z.string().optional(),
  costPrice: z.number().min(0).optional(),
  sellingPrice: z.number().min(0).optional(),
  minStockLevel: z.number().int().min(0).optional(),
  imageUrl: z.string().url().optional(),
  isActive: z.boolean().optional(),
});

router.patch("/:id", requirePermission("products.manage"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const product = await prisma.product.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
  });
  if (!product) return res.status(404).json({ error: "Product not found" });

  const priceChanged =
    (parsed.data.costPrice !== undefined && Number(product.costPrice) !== parsed.data.costPrice) ||
    (parsed.data.sellingPrice !== undefined && Number(product.sellingPrice) !== parsed.data.sellingPrice);

  try {
    const updated = await prisma.product.update({
      where: { id: product.id },
      data: parsed.data,
    });

    await recordAudit({
      businessId: req.auth!.businessId,
      userId: req.auth!.userId,
      action: priceChanged ? "PRODUCT_PRICE_CHANGED" : "PRODUCT_UPDATED",
      entity: "Product",
      entityId: updated.id,
      metadata: parsed.data,
    });

    return res.json({ product: updated });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "A product with this SKU or barcode already exists" });
    }
    throw err;
  }
});

// ---- DELETE /products/:id ----
// Deactivates by default. Only hard-deletes if it has no inventory
// history at all (e.g. created by mistake, never touched).
router.delete("/:id", requirePermission("products.manage"), async (req, res) => {
  const product = await prisma.product.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
  });
  if (!product) return res.status(404).json({ error: "Product not found" });

  const movementCount = await prisma.inventoryMovement.count({ where: { productId: product.id } });

  if (movementCount === 0) {
    await prisma.product.delete({ where: { id: product.id } });
    await recordAudit({
      businessId: req.auth!.businessId,
      userId: req.auth!.userId,
      action: "PRODUCT_DELETED",
      entity: "Product",
      entityId: product.id,
    });
    return res.status(204).send();
  }

  const updated = await prisma.product.update({
    where: { id: product.id },
    data: { isActive: false },
  });
  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "PRODUCT_DEACTIVATED",
    entity: "Product",
    entityId: product.id,
  });
  return res.json({ product: updated, note: "Product has inventory history — deactivated instead of deleted" });
});

export default router;
