import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";

// Tables/Orders/Kitchen routes are opt-in (rule #26 — "a provision store
// should never see unnecessary restaurant features"). Must run after
// authenticate(). Owner turns this on/off via PATCH /business.
export async function requireRestaurantMode(req: Request, res: Response, next: NextFunction) {
  const business = await prisma.business.findUnique({
    where: { id: req.auth!.businessId },
    select: { restaurantModeEnabled: true },
  });
  if (!business?.restaurantModeEnabled) {
    return res.status(400).json({
      error: "Restaurant mode is not enabled for this business. Turn it on with PATCH /business { \"restaurantModeEnabled\": true }.",
    });
  }
  next();
}
