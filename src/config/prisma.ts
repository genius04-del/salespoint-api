import { PrismaClient } from "@prisma/client";

// Single shared Prisma instance across the app.
//
// Prisma's default interactive-transaction timeout is 5s, which is too tight
// for multi-step business transactions (sale + stock + journal entry) when the
// database is a remote pooled connection. Raising it here applies to every
// prisma.$transaction() in the app.
export const prisma = new PrismaClient({
  transactionOptions: {
    maxWait: 10000, // max time to wait to acquire a connection
    timeout: 30000, // max time the transaction may run
  },
});
