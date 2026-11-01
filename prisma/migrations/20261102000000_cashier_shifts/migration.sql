-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN "shortCode" TEXT,
ADD COLUMN "requireShift" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "users" ADD COLUMN "staffNumber" INTEGER,
ADD COLUMN "pinHash" TEXT,
ADD COLUMN "pinFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pinLockedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloat" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "openNotes" TEXT,
    "takeOverFromId" TEXT,
    "handoverDifference" DECIMAL(12,2),
    "takenOver" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),
    "expectedCash" DECIMAL(12,2),
    "countedCash" DECIMAL(12,2),
    "variance" DECIMAL(12,2),
    "closeNotes" TEXT,
    "salesCount" INTEGER,
    "salesTotal" DECIMAL(12,2),
    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_shortCode_key" ON "businesses"("shortCode");
CREATE UNIQUE INDEX "users_businessId_staffNumber_key" ON "users"("businessId", "staffNumber");
CREATE INDEX "shifts_businessId_status_idx" ON "shifts"("businessId", "status");
CREATE INDEX "shifts_businessId_openedAt_idx" ON "shifts"("businessId", "openedAt");
CREATE INDEX "shifts_userId_status_idx" ON "shifts"("userId", "status");

-- At most one OPEN shift per cashier, enforced by the database too.
CREATE UNIQUE INDEX "shifts_one_open_per_user" ON "shifts"("userId") WHERE "status" = 'OPEN';

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
