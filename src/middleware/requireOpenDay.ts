import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";

// Optional gate for anything that takes money or starts a sale. It does
// NOTHING unless the Owner has switched on "Require an open day before
// selling" (Business.requireOpenDay) — so existing shops keep working exactly
// as before until they choose to use it. Must run after authenticate().
export async function requireOpenDay(req: Request, res: Response, next: NextFunction) {
  const businessId = req.auth!.businessId;

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { requireOpenDay: true, branchType: true },
  });
  // A production branch (central kitchen) prepares and sends stock out; it never sells.
  if (business?.branchType === "PRODUCTION") {
    return res.status(403).json({
      error: "This is a production branch. It does not sell. Switch to a shop branch to take orders.",
      code: "PRODUCTION_BRANCH",
    });
  }
  const open = await prisma.businessDay.findFirst({
    where: { businessId, status: "OPEN" },
    select: { id: true, postedAt: true },
  });

  // Once the finance posting is saved the day's money is counted: nothing more can be
  // sold into it. (Applies to every business that uses days, not only those that require one.)
  if (open?.postedAt) {
    return res.status(409).json({
      error: "The day has been cashed up (finance posting saved). Close the day and open a new one to keep selling.",
      code: "DAY_POSTED",
    });
  }

  if (!business?.requireOpenDay) return next();
  if (open) return next();

  return res.status(409).json({
    error: "The business day is not open. Open the day (Day End page) before selling.",
    code: "DAY_NOT_OPEN",
  });
}
