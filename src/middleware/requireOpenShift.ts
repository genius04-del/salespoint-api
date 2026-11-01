import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";

// Optional gate: only active when the Owner turns on "Require a shift". A
// sale or tab payment then needs the seller to have an open shift, so every
// naira in the drawer belongs to a named person. Must run after authenticate().
export async function requireOpenShift(req: Request, res: Response, next: NextFunction) {
  const { businessId, userId } = req.auth!;
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { requireShift: true } });
  if (!business?.requireShift) return next();

  const open = await prisma.shift.findFirst({ where: { businessId, userId, status: "OPEN" }, select: { id: true } });
  if (open) return next();

  return res.status(409).json({
    error: "Open your shift before selling (Shift page).",
    code: "SHIFT_NOT_OPEN",
  });
}
