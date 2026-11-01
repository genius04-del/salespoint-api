import { prisma } from "../config/prisma";
import { round2, AccountMovement } from "./financials";

// Sums every journal line per account. With `from`, it's the movement
// within [from, to] (for period reports like profit & loss). Without
// `from`, it's the cumulative balance from the beginning up to `to`
// (for balances such as cash on hand). Reports are always built from
// recorded journal entries — never from manually entered totals (rule #20).
export async function accountMovements(
  businessId: string,
  opts: { from?: Date; to: Date }
): Promise<AccountMovement[]> {
  const accounts = await prisma.account.findMany({ where: { businessId } });

  const grouped = await prisma.journalEntryLine.groupBy({
    by: ["accountId"],
    where: {
      journalEntry: {
        businessId,
        entryDate: { ...(opts.from ? { gte: opts.from } : {}), lte: opts.to },
      },
    },
    _sum: { debit: true, credit: true },
  });
  const sums = new Map(grouped.map((g) => [g.accountId, g]));

  return accounts.map((a) => {
    const g = sums.get(a.id);
    const debit = Number(g?._sum.debit ?? 0);
    const credit = Number(g?._sum.credit ?? 0);
    const net = a.normalBalance === "DEBIT" ? debit - credit : credit - debit;
    return {
      code: a.code,
      name: a.name,
      type: a.type,
      normalBalance: a.normalBalance,
      debit: round2(debit),
      credit: round2(credit),
      net: round2(net),
    };
  });
}
