-- Purchases can now carry ingredient lines (decimal quantities, 4dp unit cost).
ALTER TABLE "purchase_items" ALTER COLUMN "productId" DROP NOT NULL;
ALTER TABLE "purchase_items" ADD COLUMN "ingredientId" TEXT;
ALTER TABLE "purchase_items" ADD COLUMN "unit" TEXT;
ALTER TABLE "purchase_items" ALTER COLUMN "quantity" TYPE DECIMAL(14,3) USING "quantity"::numeric;
ALTER TABLE "purchase_items" ALTER COLUMN "costPrice" TYPE DECIMAL(14,4);
CREATE INDEX "purchase_items_ingredientId_idx" ON "purchase_items"("ingredientId");
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
