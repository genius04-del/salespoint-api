import { Prisma, InventoryMovementType } from "@prisma/client";

interface ApplyMovementParams {
  tx: Prisma.TransactionClient;
  businessId: string;
  productId: string;
  type: InventoryMovementType;
  quantityChange: number; // positive = stock in, negative = stock out
  reason?: string;
  reference?: string;
  userId?: string | null;
  allowNegativeStock?: boolean; // default false — most stock-out movements should never push quantity below 0
}

// Central choke point for every stock change. A product's currentQuantity
// must NEVER be updated anywhere else in the codebase — always go through
// this function, inside the same transaction as whatever business event
// triggered it (a sale, a purchase, a manual adjustment).
export async function applyInventoryMovement(params: ApplyMovementParams) {
  const {
    tx,
    businessId,
    productId,
    type,
    quantityChange,
    reason,
    reference,
    userId,
    allowNegativeStock = false,
  } = params;

  const product = await tx.product.findFirst({
    where: { id: productId, businessId },
  });

  if (!product) {
    throw new Error("PRODUCT_NOT_FOUND");
  }

  const newQuantity = product.currentQuantity + quantityChange;

  if (newQuantity < 0 && !allowNegativeStock) {
    throw new Error("INSUFFICIENT_STOCK");
  }

  await tx.product.update({
    where: { id: productId },
    data: { currentQuantity: newQuantity },
  });

  const movement = await tx.inventoryMovement.create({
    data: {
      businessId,
      productId,
      type,
      quantityChange,
      previousQuantity: product.currentQuantity,
      newQuantity,
      reason,
      reference,
      userId,
    },
  });

  return { movement, previousQuantity: product.currentQuantity, newQuantity };
}
