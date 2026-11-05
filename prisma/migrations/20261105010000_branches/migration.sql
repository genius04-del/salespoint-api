-- Branches: a chain of businesses under one owner, plus production-only branches.
CREATE TYPE "BranchType" AS ENUM ('OUTLET', 'PRODUCTION');

CREATE TABLE "business_groups" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "business_groups_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "businesses" ADD COLUMN "groupId" TEXT;
ALTER TABLE "businesses" ADD COLUMN "branchType" "BranchType" NOT NULL DEFAULT 'OUTLET';
ALTER TABLE "users" ADD COLUMN "groupAdminId" TEXT;
ALTER TABLE "users" ADD COLUMN "activeBusinessId" TEXT;

ALTER TABLE "businesses" ADD CONSTRAINT "businesses_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "business_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_groupAdminId_fkey" FOREIGN KEY ("groupAdminId") REFERENCES "business_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "businesses_groupId_idx" ON "businesses"("groupId");
