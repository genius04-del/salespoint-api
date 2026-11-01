import { Router } from "express";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";

const router = Router();
router.use(authenticate);


// ---- GET /finance/ledger/:accountId ----
// Chronological transaction list for one account with a running balance,
// per rule #52's "Basic Ledger" (date, reference, description, debit,
// credit, balance). Balance direction respects the account's normal side —
// a debit-normal account (e.g. Cash) increases with debits, a credit-normal
// account (e.g. Sales Revenue) increases with credits.
router.get("/ledger/:accountId", requirePermission("finance.view"), async (req, res) => {
  const account = await prisma.account.findFirst({
    where: { id: req.params.accountId, businessId: req.auth!.businessId },
  });
  if (!account) return res.status(404).json({ error: "Account not found" });

  const { from, to } = req.query;
  const where: any = { accountId: account.id, journalEntry: { businessId: req.auth!.businessId } };
  if (from || to) {
    where.journalEntry.entryDate = {};
    if (from) where.journalEntry.entryDate.gte = new Date(String(from));
    if (to) where.journalEntry.entryDate.lte = new Date(String(to));
  }

  const lines = await prisma.journalEntryLine.findMany({
    where,
    include: { journalEntry: true },
    orderBy: { journalEntry: { entryDate: "asc" } },
  });

  let balance = 0;
  const rows = lines.map((line) => {
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    balance += account.normalBalance === "DEBIT" ? debit - credit : credit - debit;
    return {
      date: line.journalEntry.entryDate,
      reference: line.journalEntry.sourceType + (line.journalEntry.sourceId ? `:${line.journalEntry.sourceId}` : ""),
      description: line.description || line.journalEntry.description,
      debit,
      credit,
      balance,
    };
  });

  return res.json({
    account: { id: account.id, code: account.code, name: account.name, normalBalance: account.normalBalance },
    entries: rows,
    closingBalance: balance,
  });
});

// ---- GET /finance/trial-balance ----
// Every active account's net balance as of now (or as of `to`, if given).
// totalDebits must equal totalCredits — that equality is itself the
// sanity check that double-entry has stayed balanced (rule #61).
router.get("/trial-balance", requirePermission("finance.view"), async (req, res) => {
  const { to } = req.query;

  const accounts = await prisma.account.findMany({
    where: { businessId: req.auth!.businessId, isActive: true },
    include: {
      journalLines: {
        where: to ? { journalEntry: { entryDate: { lte: new Date(String(to)) } } } : undefined,
      },
    },
    orderBy: { code: "asc" },
  });

  let totalDebits = 0;
  let totalCredits = 0;

  const rows = accounts.map((account) => {
    const debitSum = account.journalLines.reduce((s, l) => s + Number(l.debit), 0);
    const creditSum = account.journalLines.reduce((s, l) => s + Number(l.credit), 0);
    const net = account.normalBalance === "DEBIT" ? debitSum - creditSum : creditSum - debitSum;

    // Trial balance convention: show the balance on its normal side.
    const debitColumn = account.normalBalance === "DEBIT" ? Math.max(net, 0) : Math.max(-net, 0);
    const creditColumn = account.normalBalance === "CREDIT" ? Math.max(net, 0) : Math.max(-net, 0);
    totalDebits += debitColumn;
    totalCredits += creditColumn;

    return {
      code: account.code,
      name: account.name,
      type: account.type,
      debit: debitColumn,
      credit: creditColumn,
    };
  });

  return res.json({
    accounts: rows,
    totalDebits,
    totalCredits,
    balanced: Math.abs(totalDebits - totalCredits) < 0.005,
  });
});

export default router;
