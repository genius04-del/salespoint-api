-- Finance posting: numbered business days and the notes/coins counted.
ALTER TABLE "businesses" ADD COLUMN "dayCounter" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "business_days" ADD COLUMN "number" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "business_days" ADD COLUMN "openDenominations" JSONB;
ALTER TABLE "business_days" ADD COLUMN "closeDenominations" JSONB;

-- Number the days that already exist, oldest first, per business.
UPDATE "business_days" d
SET "number" = r.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "businessId" ORDER BY "openedAt", id) AS rn
  FROM "business_days"
) r
WHERE d.id = r.id;

UPDATE "businesses" b
SET "dayCounter" = c.n
FROM (SELECT "businessId", COUNT(*)::int AS n FROM "business_days" GROUP BY "businessId") c
WHERE b.id = c."businessId";
