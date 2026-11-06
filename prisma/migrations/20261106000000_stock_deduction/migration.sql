-- Deduct sales from stock at day end (restaurants), with a history of each run.
ALTER TABLE "businesses" ADD COLUMN "deductionCounter" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "businesses" ADD COLUMN "deductStockAtDayEnd" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "businesses" ADD COLUMN "stockDeductionStart" TIMESTAMP(3);

CREATE TYPE "DeductionStatus" AS ENUM ('PENDING', 'APPLIED');

CREATE TABLE "stock_deductions" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "fromAt" TIMESTAMP(3) NOT NULL,
  "toAt" TIMESTAMP(3) NOT NULL,
  "salesCount" INTEGER NOT NULL,
  "lines" JSONB NOT NULL,
  "status" "DeductionStatus" NOT NULL DEFAULT 'PENDING',
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" TIMESTAMP(3),
  "appliedById" TEXT,
  CONSTRAINT "stock_deductions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "stock_deductions_businessId_toAt_idx" ON "stock_deductions"("businessId", "toAt");
ALTER TABLE "stock_deductions" ADD CONSTRAINT "stock_deductions_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing restaurants move to day-end deduction; sales so far were deducted as they happened.
UPDATE "businesses" SET "deductStockAtDayEnd" = true, "stockDeductionStart" = NOW() WHERE "restaurantModeEnabled" = true;
