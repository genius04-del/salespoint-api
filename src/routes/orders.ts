import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { requireRestaurantMode } from "../middleware/restaurantMode";
import { recordAudit } from "../utils/audit";
import { applyProductStock, productsWithRecipes } from "../services/productStock";
import { nextReceiptNumber, mapPricingError } from "../services/salePricing";
import { postSaleJournalEntry } from "../services/saleJournal";

const router = Router();
router.use(authenticate, requireRestaurantMode);

const orderItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive(),
  notes: z.string().optional(),
});

// Adds items to stock-committed OrderItems, in the given transaction.
// Shared by order creation and "add more items to an open order" — food
// service consumes ingredients on preparation, not on eventual payment, so
// stock is reduced here, well before checkout.
async function addItemsToOrder(
  tx: Prisma.TransactionClient,
  params: { businessId: string; orderId: string; items: { productId: string; quantity: number; notes?: string }[]; userId: string }
) {
  const productIds = params.items.map((i) => i.productId);
  const products = await tx.product.findMany({
    where: { id: { in: productIds }, businessId: params.businessId },
  });
  if (products.length !== new Set(productIds).size) {
    throw new Error("PRODUCT_NOT_FOUND");
  }
  const productMap = new Map(products.map((p) => [p.id, p]));
  // Dishes made from a recipe are stocked by their ingredients, not by their own quantity.
  const recipeProducts = await productsWithRecipes(tx, productIds);

  for (const item of params.items) {
    const product = productMap.get(item.productId)!;
    if (!product.isActive) throw new Error(`PRODUCT_INACTIVE:${product.name}`);
    if (!recipeProducts.has(product.id) && product.currentQuantity < item.quantity) throw new Error(`INSUFFICIENT_STOCK:${product.name}`);
  }

  const created = [];
  for (const item of params.items) {
    const product = productMap.get(item.productId)!;
    const orderItem = await tx.orderItem.create({
      data: {
        orderId: params.orderId,
        productId: product.id,
        productName: product.name,
        unitPrice: product.sellingPrice,
        unitCost: product.costPrice,
        quantity: item.quantity,
        notes: item.notes,
      },
    });
    await applyProductStock({
      tx,
      businessId: params.businessId,
      productId: product.id,
      type: "SALE",
      quantityChange: -item.quantity,
      reason: `Order item: ${product.name}`,
      reference: params.orderId,
      userId: params.userId,
    });
    created.push(orderItem);
  }
  return created;
}

// ---- POST /orders ---- open a new tab
const createOrderSchema = z.object({
  tableId: z.string().optional(),
  items: z.array(orderItemSchema).min(1),
  notes: z.string().optional(),
});

router.post("/", requirePermission("sales.create"), async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tableId, items, notes } = parsed.data;

  try {
    const order = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (tableId) {
        const table = await tx.table.findFirst({ where: { id: tableId, businessId: req.auth!.businessId } });
        if (!table) throw new Error("TABLE_NOT_FOUND");
      }

      const created = await tx.order.create({
        data: { businessId: req.auth!.businessId, tableId, createdById: req.auth!.userId, notes },
      });

      await addItemsToOrder(tx, { businessId: req.auth!.businessId, orderId: created.id, items, userId: req.auth!.userId });

      if (tableId) {
        await tx.table.update({ where: { id: tableId }, data: { status: "OCCUPIED" } });
      }

      return tx.order.findUniqueOrThrow({ where: { id: created.id }, include: { items: true, table: true } });
    });

    await recordAudit({
      businessId: req.auth!.businessId,
      userId: req.auth!.userId,
      action: "ORDER_OPENED",
      entity: "Order",
      entityId: order.id,
      metadata: { tableId },
    });

    return res.status(201).json({ order });
  } catch (err: any) {
    if (err.message === "TABLE_NOT_FOUND") return res.status(400).json({ error: "Table not found for this business" });
    const mapped = mapPricingError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.error });
    throw err;
  }
});

// ---- GET /orders ---- filters: status, tableId
router.get("/", requirePermission("sales.view", "sales.create", "kitchen.manage"), async (req, res) => {
  const { status, tableId } = req.query;
  const where: any = { businessId: req.auth!.businessId };
  if (status) where.status = String(status);
  if (tableId) where.tableId = String(tableId);

  const orders = await prisma.order.findMany({
    where,
    include: { items: true, table: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  // Who opened each tab, so the kitchen and the floor know whose it is.
  const ids = [...new Set(orders.map((o: any) => o.createdById))] as string[];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids }, businessId: req.auth!.businessId }, select: { id: true, name: true } }) : [];
  const nameById = new Map(users.map((u: any) => [u.id, u.name]));
  return res.json({ orders: orders.map((o: any) => ({ ...o, createdByName: nameById.get(o.createdById) ?? null })) });
});

// ---- GET /orders/:id ----
router.get("/:id", requirePermission("sales.view", "sales.create", "kitchen.manage"), async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
    include: { items: true, table: true },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });
  return res.json({ order });
});

// ---- POST /orders/:id/items ---- add more items to an open order
router.post("/:id/items", requirePermission("sales.create"), async (req, res) => {
  const parsed = z.object({ items: z.array(orderItemSchema).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const order = await prisma.order.findFirst({ where: { id: req.params.id, businessId: req.auth!.businessId } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "OPEN") return res.status(409).json({ error: `Order is ${order.status}, not OPEN` });

  try {
    const items = await prisma.$transaction(async (tx: Prisma.TransactionClient) =>
      addItemsToOrder(tx, {
        businessId: req.auth!.businessId,
        orderId: order.id,
        items: parsed.data.items,
        userId: req.auth!.userId,
      })
    );

    await recordAudit({
      businessId: req.auth!.businessId,
      userId: req.auth!.userId,
      action: "ORDER_ITEMS_ADDED",
      entity: "Order",
      entityId: order.id,
      metadata: { count: items.length },
    });

    return res.status(201).json({ items });
  } catch (err: any) {
    const mapped = mapPricingError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.error });
    throw err;
  }
});

// ---- PATCH /orders/items/:itemId/status ---- the kitchen ticket workflow
const statusSchema = z.object({
  status: z.enum(["NEW", "PREPARING", "READY", "SERVED", "CANCELLED"]),
});

router.patch("/items/:itemId/status", requirePermission("kitchen.manage"), async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const item = await prisma.orderItem.findFirst({
    where: { id: req.params.itemId, order: { businessId: req.auth!.businessId } },
    include: { order: true },
  });
  if (!item) return res.status(404).json({ error: "Order item not found" });
  if (item.order.status !== "OPEN") {
    return res.status(409).json({ error: `Order is ${item.order.status}, not OPEN` });
  }
  if (item.kitchenStatus === "CANCELLED" || item.kitchenStatus === "SERVED") {
    return res.status(409).json({ error: `Item is already ${item.kitchenStatus} and can't be changed` });
  }

  // Cancelling a single ticket (e.g. kitchen is out of an ingredient)
  // reverses just that item's stock — nothing else on the order is touched.
  if (parsed.data.status === "CANCELLED") {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await applyProductStock({
        tx,
        businessId: req.auth!.businessId,
        productId: item.productId,
        type: "RETURN",
        quantityChange: item.quantity,
        reason: `Order item cancelled: ${item.productName}`,
        reference: item.orderId,
        userId: req.auth!.userId,
        allowNegativeStock: true,
      });
      await tx.orderItem.update({ where: { id: item.id }, data: { kitchenStatus: "CANCELLED" } });
    });
  } else {
    await prisma.orderItem.update({ where: { id: item.id }, data: { kitchenStatus: parsed.data.status } });
  }

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "ORDER_ITEM_STATUS_CHANGED",
    entity: "OrderItem",
    entityId: item.id,
    metadata: { from: item.kitchenStatus, to: parsed.data.status },
  });

  const updated = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
  return res.json({ item: updated });
});

// ---- POST /orders/:id/cancel ---- void the whole tab before payment
router.post("/:id/cancel", requirePermission("sales.cancel"), async (req, res) => {
  const parsed = z.object({ reason: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const order = await prisma.order.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
    include: { items: true },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "OPEN") return res.status(409).json({ error: `Order is already ${order.status}` });

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const item of order.items) {
      if (item.kitchenStatus === "CANCELLED") continue; // already reversed individually
      await applyProductStock({
        tx,
        businessId: req.auth!.businessId,
        productId: item.productId,
        type: "RETURN",
        quantityChange: item.quantity,
        reason: `Order cancelled: ${parsed.data.reason}`,
        reference: order.id,
        userId: req.auth!.userId,
        allowNegativeStock: true,
      });
    }
    await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    if (order.tableId) {
      await tx.table.update({ where: { id: order.tableId }, data: { status: "NEEDS_CLEANING" } });
    }
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "ORDER_CANCELLED",
    entity: "Order",
    entityId: order.id,
    metadata: { reason: parsed.data.reason },
  });

  return res.json({ message: "Order cancelled and stock restored" });
});

// ---- POST /orders/:id/checkout ---- pay the tab, turning it into a real Sale
// Paystack isn't supported for dine-in checkout yet — only manually-confirmed
// methods, same limitation as regular checkout before Phase 5's webhook flow
// was extended here.
const checkoutSchema = z.object({
  paymentMethod: z.enum(["CASH", "MOBILE_MONEY", "BANK_TRANSFER", "OTHER"]),
  customerId: z.string().optional(),
  amountTendered: z.number().min(0).optional(),
});

router.post("/:id/checkout", requirePermission("sales.create"), async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { paymentMethod, customerId, amountTendered } = parsed.data;

  const order = await prisma.order.findFirst({
    where: { id: req.params.id, businessId: req.auth!.businessId },
    include: { items: true },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "OPEN") return res.status(409).json({ error: `Order is already ${order.status}` });

  const billableItems = order.items.filter((i) => i.kitchenStatus !== "CANCELLED");
  if (billableItems.length === 0) {
    return res.status(400).json({ error: "This order has no billable items — cancel it instead" });
  }

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (customerId) {
        const customer = await tx.customer.findFirst({ where: { id: customerId, businessId: req.auth!.businessId } });
        if (!customer) throw new Error("CUSTOMER_NOT_FOUND");
      }

      const total = billableItems.reduce(
        (sum, i) => sum.add(i.unitPrice.mul(i.quantity)),
        new Prisma.Decimal(0)
      );

      if (paymentMethod === "CASH" && amountTendered !== undefined && amountTendered < Number(total)) {
        throw new Error("INSUFFICIENT_TENDER");
      }

      const receiptNumber = await nextReceiptNumber(tx, req.auth!.businessId);

      const sale = await tx.sale.create({
        data: {
          businessId: req.auth!.businessId,
          cashierId: req.auth!.userId,
          customerId: customerId ?? null,
          receiptNumber,
          subtotal: total,
          discountTotal: 0,
          total,
          paymentMethod,
          paymentStatus: "SUCCESSFUL",
          amountTendered: amountTendered ?? null,
          changeGiven:
            paymentMethod === "CASH" && amountTendered !== undefined
              ? new Prisma.Decimal(amountTendered).sub(total)
              : null,
          notes: order.notes,
          items: {
            create: billableItems.map((i) => ({
              productId: i.productId,
              productName: i.productName,
              unitPrice: i.unitPrice,
              unitCost: i.unitCost,
              quantity: i.quantity,
              discount: 0,
              lineTotal: i.unitPrice.mul(i.quantity),
            })),
          },
        },
        include: { items: true },
      });

      // Stock was already reduced when each item was added to the order —
      // this only posts the accounting entry, it does NOT touch stock again.
      await postSaleJournalEntry({
        tx,
        businessId: req.auth!.businessId,
        saleId: sale.id,
        receiptNumber,
        paymentMethod,
        total,
        lineData: billableItems.map((i) => ({
          product: { costPrice: i.unitCost },
          item: { quantity: i.quantity },
        })),
        createdById: req.auth!.userId,
      });

      await tx.order.update({ where: { id: order.id }, data: { status: "CLOSED", saleId: sale.id } });
      if (order.tableId) {
        await tx.table.update({ where: { id: order.tableId }, data: { status: "NEEDS_CLEANING" } });
      }

      return sale;
    });

    await recordAudit({
      businessId: req.auth!.businessId,
      userId: req.auth!.userId,
      action: "ORDER_CHECKED_OUT",
      entity: "Sale",
      entityId: result.id,
      metadata: { orderId: order.id, receiptNumber: result.receiptNumber },
    });

    return res.status(201).json({ sale: result });
  } catch (err: any) {
    if (err.message === "CUSTOMER_NOT_FOUND") return res.status(400).json({ error: "Customer not found for this business" });
    if (err.message === "INSUFFICIENT_TENDER") return res.status(400).json({ error: "Amount tendered is less than the total due" });
    throw err;
  }
});

export default router;
