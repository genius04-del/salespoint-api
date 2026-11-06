-- Finance posting (the cash-up) is now its own step before the day is closed.
ALTER TABLE "business_days" ADD COLUMN "postedAt" TIMESTAMP(3);
ALTER TABLE "business_days" ADD COLUMN "postedById" TEXT;
-- Days already closed were cashed up when they closed.
UPDATE "business_days" SET "postedAt" = "closedAt", "postedById" = "closedById" WHERE "status" = 'CLOSED';
