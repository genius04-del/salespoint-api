-- CreateEnum
CREATE TYPE "IngredientMovementType" AS ENUM ('OPENING_STOCK', 'PURCHASE', 'PRODUCTION_IN', 'PRODUCTION_OUT', 'SALE_USAGE', 'SALE_RETURN', 'WASTE', 'COUNT_ADJUSTMENT', 'ADJUSTMENT');
CREATE TYPE "StockCountStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');
CREATE TYPE "StockItemType" AS ENUM ('PRODUCT', 'INGREDIENT');

-- CreateTable
CREATE TABLE "ingredients" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'kg',
    "isPrepared" BOOLEAN NOT NULL DEFAULT false,
    "currentQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "minStockLevel" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "costPerUnit" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ingredient_movements" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "type" "IngredientMovementType" NOT NULL,
    "quantityChange" DECIMAL(14,3) NOT NULL,
    "previousQuantity" DECIMAL(14,3) NOT NULL,
    "newQuantity" DECIMAL(14,3) NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "reference" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ingredient_movements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "recipe_lines" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    CONSTRAINT "recipe_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "prep_components" (
    "id" TEXT NOT NULL,
    "outputId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    CONSTRAINT "prep_components_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "production_batches" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "outputId" TEXT NOT NULL,
    "quantityProduced" DECIMAL(14,3) NOT NULL,
    "totalCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "producedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "production_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "production_batch_lines" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "quantityUsed" DECIMAL(14,3) NOT NULL,
    "standardQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    CONSTRAINT "production_batch_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_counts" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'DRAFT',
    "scope" TEXT NOT NULL DEFAULT 'ALL',
    "notes" TEXT,
    "countedById" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "totalVarianceValue" DECIMAL(14,2),
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_count_lines" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "itemType" "StockItemType" NOT NULL,
    "productId" TEXT,
    "ingredientId" TEXT,
    "itemName" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "expected" DECIMAL(14,3) NOT NULL,
    "counted" DECIMAL(14,3),
    "variance" DECIMAL(14,3),
    "unitCost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "varianceValue" DECIMAL(14,2),
    CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ingredients_businessId_name_key" ON "ingredients"("businessId", "name");
CREATE INDEX "ingredients_businessId_isActive_idx" ON "ingredients"("businessId", "isActive");
CREATE INDEX "ingredient_movements_businessId_ingredientId_createdAt_idx" ON "ingredient_movements"("businessId", "ingredientId", "createdAt");
CREATE INDEX "ingredient_movements_businessId_type_createdAt_idx" ON "ingredient_movements"("businessId", "type", "createdAt");
CREATE UNIQUE INDEX "recipe_lines_productId_ingredientId_key" ON "recipe_lines"("productId", "ingredientId");
CREATE INDEX "recipe_lines_ingredientId_idx" ON "recipe_lines"("ingredientId");
CREATE UNIQUE INDEX "prep_components_outputId_componentId_key" ON "prep_components"("outputId", "componentId");
CREATE INDEX "production_batches_businessId_createdAt_idx" ON "production_batches"("businessId", "createdAt");
CREATE INDEX "production_batch_lines_batchId_idx" ON "production_batch_lines"("batchId");
CREATE INDEX "stock_counts_businessId_status_idx" ON "stock_counts"("businessId", "status");
CREATE INDEX "stock_counts_businessId_createdAt_idx" ON "stock_counts"("businessId", "createdAt");
CREATE INDEX "stock_count_lines_countId_idx" ON "stock_count_lines"("countId");

-- AddForeignKey
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ingredient_movements" ADD CONSTRAINT "ingredient_movements_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ingredient_movements" ADD CONSTRAINT "ingredient_movements_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prep_components" ADD CONSTRAINT "prep_components_outputId_fkey" FOREIGN KEY ("outputId") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prep_components" ADD CONSTRAINT "prep_components_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_outputId_fkey" FOREIGN KEY ("outputId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_batch_lines" ADD CONSTRAINT "production_batch_lines_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "production_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "production_batch_lines" ADD CONSTRAINT "production_batch_lines_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_countId_fkey" FOREIGN KEY ("countId") REFERENCES "stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
