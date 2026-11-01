import { PrismaClient } from "@prisma/client";

// Every integration test file imports `itDb` instead of vitest's `it` (or
// checks `hasTestDb` directly) so the whole suite skips cleanly — not
// red/failing — when there's no database configured to run against. See
// README.md in this folder for how to actually run these.
export const hasTestDb = !!process.env.TEST_DATABASE_URL;

export const testPrisma = hasTestDb
  ? new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })
  : (null as unknown as PrismaClient);
