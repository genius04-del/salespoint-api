import { Prisma } from "@prisma/client";
import { productsWithRecipes } from "./productStock";
import { getDeductionState } from "./stockDeduction";

export interface SaleLineInput {
  productId: string;
  quantity: number;
  discount: number;
}

// Validates products exist/active/in-stock and computes priced line items.
// Used by both the manual checkout path and the Paystack post-verification
// finalize path, so a sale is priced identically no matter how it was paid.
// Throws Error with a recognizable message; callers map these to HTTP codes.
export async function priceSaleItems(
  tx: Prisma.TransactionClient,
  businessId: string,
  items: SaleLineInput[],
  opts: { allowOversell?: boolean } = {}
) {
  const productIds = items.map((i) => i.productId);
  const products = await tx.product.findMany({
    where: { id: { in: productIds }, businessId },
  });

  if (products.length !== new Set(productIds).size) {
    throw new Error("PRODUCT_NOT_FOUND");
  }
  const productMap = new Map(products.map((p) => [p.id, p]));

  // Dishes made from a recipe are stocked by their ingredients, so their own
  // quantity (always 0) must not block the sale.
  const recipeProducts = await productsWithRecipes(tx, productIds);
  // Day-end restaurants sell freely; stock is deducted afterwards by the manager.
  const { dayEnd } = await getDeductionState(tx, businessId);

  let oversold = false;
  for (const item of items) {
    const product = productMap.get(item.productId)!;
    if (!product.isActive) {
      throw new Error(`PRODUCT_INACTIVE:${product.name}`);
    }
    if (!dayEnd && !recipeProducts.has(product.id) && product.currentQuantity < item.quantity) {
      if (!opts.allowOversell) {
        throw new Error(`INSUFFICIENT_STOCK:${product.name}`);
      }
      oversold = true; // payment already collected — flag for reconciliation instead of blocking
    }
  }

  let subtotal = new Prisma.Decimal(0);
  let discountTotal = new Prisma.Decimal(0);
  const lineData = items.map((item) => {
    const product = productMap.get(item.productId)!;
    const lineGross = product.sellingPrice.mul(item.quantity);
    const discount = new Prisma.Decimal(item.discount);
    const lineTotal = lineGross.sub(discount);
    subtotal = subtotal.add(lineGross);
    discountTotal = discountTotal.add(discount);
    return { product, item, lineTotal, unitPrice: product.sellingPrice };
  });
  const total = subtotal.sub(discountTotal);

  return { lineData, subtotal, discountTotal, total, oversold };
}

// Atomically bumps the business's receipt counter — the row-level lock this
// UPDATE takes is what keeps receipt numbers unique under concurrent checkouts.
export async function nextReceiptNumber(tx: Prisma.TransactionClient, businessId: string) {
  const business = await tx.business.update({
    where: { id: businessId },
    data: { receiptCounter: { increment: 1 } },
  });
  return `RCT-${String(business.receiptCounter).padStart(6, "0")}`;
}

// Maps the error messages priceSaleItems/checkout throw to an HTTP response.
// Returns null if the error isn't one of these recognized cases.
export function mapPricingError(err: any): { status: number; error: string } | null {
  const message = err?.message as string | undefined;
  if (!message) return null;
  if (message === "CUSTOMER_NOT_FOUND") {
    return { status: 400, error: "Customer not found for this business" };
  }
  if (message === "PRODUCT_NOT_FOUND") {
    return { status: 400, error: "One or more products not found for this business" };
  }
  if (message.startsWith("PRODUCT_INACTIVE:")) {
    return { status: 400, error: `Product is inactive: ${message.split(":")[1]}` };
  }
  if (message.startsWith("INSUFFICIENT_STOCK:")) {
    return { status: 409, error: `Not enough stock: ${message.split(":")[1]}` };
  }
  if (message === "INSUFFICIENT_TENDER") {
    return { status: 400, error: "Amount tendered is less than the total due" };
  }
  return null;
}
