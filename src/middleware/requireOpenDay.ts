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
    select: { requireOpenDay: true },
  });
  if (!business?.requireOpenDay) return next();

  const open = await prisma.businessDay.findFirst({
    where: { businessId, status: "OPEN" },
    select: { id: true },
  });
  if (open) return next();

  return res.status(409).json({
    error: "The business day is not open. Open the day (Day End page) before selling.",
    code: "DAY_NOT_OPEN",
  });
}
