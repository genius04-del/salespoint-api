-- Stock journal numbers, recipe yield, item categories.
ALTER TABLE "businesses" ADD COLUMN "productionCounter" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ingredients" ADD COLUMN "category" TEXT;
ALTER TABLE "ingredients" ADD COLUMN "batchYield" DECIMAL(14,3);
ALTER TABLE "prep_components" ALTER COLUMN "quantity" TYPE DECIMAL(14,6);
ALTER TABLE "production_batches" ADD COLUMN "number" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "production_batches" ADD COLUMN "reason" TEXT;
ALTER TABLE "stock_count_lines" ADD COLUMN "category" TEXT;

-- Number the journal entries that already exist, oldest first, per business.
UPDATE "production_batches" p
SET "number" = r.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "businessId" ORDER BY "createdAt", id) AS rn
  FROM "production_batches"
) r
WHERE p.id = r.id;

UPDATE "businesses" b
SET "productionCounter" = c.n
FROM (SELECT "businessId", COUNT(*)::int AS n FROM "production_batches" GROUP BY "businessId") c
WHERE b.id = c."businessId";
