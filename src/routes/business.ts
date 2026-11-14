import { isRestaurantType } from "../utils/businessType";
import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, authorize } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import { countPendingSales, getDeductionState } from "../services/stockDeduction";
import { encrypt } from "../services/encryption";
import { looksLikePaystackPublicKey, looksLikePaystackSecretKey } from "../services/paystack";

const router = Router();
router.use(authenticate);

// Every business record read in this file explicitly selects columns and
// NEVER includes paystackSecretKeyEncrypted — not even to the Owner. A
// Prisma `findUnique` with no `select` would return every column, so that
// omission has to be deliberate and explicit every time, not relied on by
// accident. The one function allowed to touch that column directly is
// src/services/businessPaystackKeys.ts, used only right before a Paystack
// API call — never to serve it back in an API response.
const SAFE_BUSINESS_SELECT = {
  id: true,
  name: true,
  phone: true,
  address: true,
  logoUrl: true,
  currency: true,
  businessType: true,
  isActive: true,
  restaurantModeEnabled: true,
  deductStockAtDayEnd: true,
  receiptCounter: true,
  paystackPublicKey: true,
  paystackConfiguredAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toBusinessResponse<T extends { paystackConfiguredAt: Date | null }>(business: T) {
  // paystackConfigured is derived for the client rather than exposing
  // paystackConfiguredAt's presence as the signal directly — keeps the
  // response shape stable even if we later track configuration differently.
  return { ...business, paystackConfigured: business.paystackConfiguredAt !== null };
}

// ---- GET /business ---- current user's own business only
router.get("/", async (req, res) => {
  const business = await prisma.business.findUnique({
    where: { id: req.auth!.businessId },
    select: SAFE_BUSINESS_SELECT,
  });
  if (!business) return res.status(404).json({ error: "Business not found" });
  return res.json({ business: toBusinessResponse(business) });
});

// ---- PATCH /business ---- update settings, owner only
const updateSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  logoUrl: z.string().url().optional(),
  currency: z.string().length(3).optional(),
  businessType: z.string().min(2).optional(),
  restaurantModeEnabled: z.boolean().optional(),
  deductStockAtDayEnd: z.boolean().optional(),
});

router.patch("/", authorize("OWNER"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const data: Record<string, unknown> = { ...parsed.data };

  // Restaurant features are only for restaurants and bars. A shop can't switch them on.
  if (parsed.data.restaurantModeEnabled === true || parsed.data.deductStockAtDayEnd === true) {
    const current = await prisma.business.findUnique({ where: { id: req.auth!.businessId }, select: { businessType: true } });
    if (!isRestaurantType(parsed.data.businessType ?? current?.businessType)) {
      return res.status(400).json({ error: "Restaurant mode is only for restaurants and bars. Change the business type first if this is a restaurant." });
    }
  }

  if (parsed.data.deductStockAtDayEnd !== undefined) {
    const state = await getDeductionState(prisma as unknown as Prisma.TransactionClient, req.auth!.businessId);
    if (parsed.data.deductStockAtDayEnd && !state.dayEnd) {
      data.stockDeductionStart = new Date(); // everything sold so far was already deducted as it happened
    }
    if (!parsed.data.deductStockAtDayEnd && state.dayEnd) {
      const pending = await countPendingSales(prisma as unknown as Prisma.TransactionClient, req.auth!.businessId, state);
      if (state.pending) return res.status(409).json({ error: `Deduction SD-${String(state.pending.number).padStart(4, "0")} is waiting in Stock Adjustment. Save or cancel it first, then switch this off.` });
      if (pending > 0) return res.status(409).json({ error: `${pending} sale${pending === 1 ? " is" : "s are"} still waiting to be deducted from stock. Run the deduction first, then switch this off.` });
    }
  }

  const updated = await prisma.business.update({
    where: { id: req.auth!.businessId },
    data,
    select: SAFE_BUSINESS_SELECT,
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "BUSINESS_SETTINGS_UPDATED",
    entity: "Business",
    entityId: updated.id,
    metadata: parsed.data,
  });

  return res.json({ business: toBusinessResponse(updated) });
});

// ---- GET /business/paystack-settings ----
// Returns only the public key and a configured flag — the secret key
// itself is write-only, the same pattern as a password: you can replace
// it, never read it back.
router.get("/paystack-settings", authorize("OWNER"), async (req, res) => {
  const business = await prisma.business.findUnique({
    where: { id: req.auth!.businessId },
    select: { paystackPublicKey: true, paystackConfiguredAt: true },
  });
  if (!business) return res.status(404).json({ error: "Business not found" });

  return res.json({
    publicKey: business.paystackPublicKey,
    isConfigured: business.paystackConfiguredAt !== null,
    configuredAt: business.paystackConfiguredAt,
  });
});

// ---- PUT /business/paystack-settings ----
// Owner only — this is how customer payments start settling to THIS
// business's own bank account instead of a shared platform account.
const paystackSettingsSchema = z.object({
  publicKey: z.string().refine(looksLikePaystackPublicKey, {
    message: "That doesn't look like a Paystack public key (should start with pk_test_ or pk_live_)",
  }),
  secretKey: z.string().refine(looksLikePaystackSecretKey, {
    message: "That doesn't look like a Paystack secret key (should start with sk_test_ or sk_live_)",
  }),
});

router.put("/paystack-settings", authorize("OWNER"), async (req, res) => {
  const parsed = paystackSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Mixing a test public key with a live secret key (or vice versa) is a
  // classic copy-paste mistake that would otherwise fail confusingly later.
  const publicEnv = parsed.data.publicKey.includes("_test_") ? "test" : "live";
  const secretEnv = parsed.data.secretKey.includes("_test_") ? "test" : "live";
  if (publicEnv !== secretEnv) {
    return res.status(400).json({
      error: `Key mismatch: the public key looks like a ${publicEnv} key but the secret key looks like a ${secretEnv} key. Both must be from the same Paystack mode.`,
    });
  }

  await prisma.business.update({
    where: { id: req.auth!.businessId },
    data: {
      paystackPublicKey: parsed.data.publicKey,
      paystackSecretKeyEncrypted: encrypt(parsed.data.secretKey),
      paystackConfiguredAt: new Date(),
    },
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "PAYSTACK_SETTINGS_UPDATED",
    entity: "Business",
    entityId: req.auth!.businessId,
    metadata: { mode: publicEnv }, // never log the actual key values
  });

  return res.json({ publicKey: parsed.data.publicKey, isConfigured: true, configuredAt: new Date() });
});

// ---- DELETE /business/paystack-settings ---- disconnect Paystack
router.delete("/paystack-settings", authorize("OWNER"), async (req, res) => {
  await prisma.business.update({
    where: { id: req.auth!.businessId },
    data: { paystackPublicKey: null, paystackSecretKeyEncrypted: null, paystackConfiguredAt: null },
  });

  await recordAudit({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
    action: "PAYSTACK_SETTINGS_REMOVED",
    entity: "Business",
    entityId: req.auth!.businessId,
  });

  return res.json({ isConfigured: false });
});

export default router;
