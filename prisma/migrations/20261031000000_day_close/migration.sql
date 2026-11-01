-- CreateEnum
CREATE TYPE "BusinessDayStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN "requireOpenDay" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "business_days" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "status" "BusinessDayStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedById" TEXT NOT NULL,
    "openingFloat" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "openNotes" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closeNotes" TEXT,
    "totalExpected" DECIMAL(12,2),
    "totalCounted" DECIMAL(12,2),
    "totalVariance" DECIMAL(12,2),

    CONSTRAINT "business_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_day_counts" (
    "id" TEXT NOT NULL,
    "dayId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "expected" DECIMAL(12,2) NOT NULL,
    "counted" DECIMAL(12,2) NOT NULL,
    "variance" DECIMAL(12,2) NOT NULL,
    "journalEntryId" TEXT,

    CONSTRAINT "business_day_counts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "business_days_businessId_status_idx" ON "business_days"("businessId", "status");

-- CreateIndex
CREATE INDEX "business_days_businessId_openedAt_idx" ON "business_days"("businessId", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "business_day_counts_dayId_method_key" ON "business_day_counts"("dayId", "method");

-- AddForeignKey
ALTER TABLE "business_days" ADD CONSTRAINT "business_days_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_day_counts" ADD CONSTRAINT "business_day_counts_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "business_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;
