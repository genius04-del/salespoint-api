import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { authenticate, requirePermission } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import { priceSaleItems, mapPricingError } from "../services/salePricing";
import { initializeTransaction } from "../services/paystack";
import { finalizePaystackTransaction } from "../services/paystackFinalize";
import { getBusinessPaystackSecretKey, PaystackNotConfiguredError } from "../services/businessPaystackKeys";

const router = Router();
router.use(authenticate);


const saleItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive(),
  discount: z.number().min(0).default(0),
});

const initSchema = z.object({
  items: z.array(saleItemSchema).min(1),
  customerId: z.string().optional(),
  customerEmail: z.string().email(), // Paystack requires an email for the payment page
  notes: z.string().optional(),
});

// ---- POST /payments/paystack/initialize ----
router.post("/paystack/initialize", requirePermission("sales.create"), async (req, res) => {
  const parsed = initSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { items, customerId, customerEmail, notes } = parsed.data;

  try {
    if (customerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: customerId, businessId: req.auth!.businessId },
      });
      if (!customer) return res.status(400).json({ error: "Customer not found for this business" });
    }

    // This business's own Paystack account — the payment settles to THEIR
    // bank account, not a shared platform account. Throws
    // PaystackNotConfiguredError (caught below) if they haven't added keys yet.
    const secretKey = await getBusinessPaystackSecretKey(req.auth!.businessId);

    // Read-only pricing check now, purely to quote a total and confirm the
    // cart is valid. Stock is re-checked for real at finalize time, since
    // time will pass between this call and the customer actually paying.
    const { total } = await priceSaleItems(prisma as any, req.auth!.businessId, items);

    const reference = `sp_${crypto.randomUUID()}`;

    const paystackResult = await initializeTransaction(
      {
        email: customerEmail,
        amountInMainUnit: Number(total),
        reference,
        callbackUrl: process.env.PAYSTACK_CALLBACK_URL,
        metadata: { businessId: req.auth!.businessId, initiatedById: req.auth!.userId },
      },
      secretKey
    );

    const transaction = await prisma.paystackTransaction.create({
      data: {
        businessId: req.auth!.businessId,
        reference,
        amount: total,
        initiatedById: req.auth!.userId,
        customerEmail,
        payload: { items, customerId, notes },
        authorizationUrl: paystackResult.authorization_url,
        accessCode: paystackResult.access_code,
      },
    });

    await recordAudit({
      businessId: req.auth!.businessId,
      userId: req.auth!.userId,
      action: "PAYMENT_INITIATED",
      entity: "PaystackTransaction",
      entityId: transaction.id,
      metadata: { reference, amount: total },
    });

    return res.status(201).json({
      reference,
      amount: total,
      authorizationUrl: paystackResult.authorization_url,
      accessCode: paystackResult.access_code,
    });
  } catch (err: any) {
    if (err instanceof PaystackNotConfiguredError) {
      return res.status(400).json({ error: err.message });
    }
    const mapped = mapPricingError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.error });
    if (err.message?.startsWith("Paystack")) {
      return res.status(502).json({ error: err.message });
    }
    throw err;
  }
});

// ---- GET /payments/paystack/:reference/status ----
// Cashier UI polls this while the customer pays. If our record is still
// PENDING, this self-heals by independently re-verifying with Paystack —
// useful if the webhook is delayed or was missed — but the source of truth
// is always verifyTransaction(), never the client.
router.get("/paystack/:reference/status", requirePermission("sales.view"), async (req, res) => {
  const transaction = await prisma.paystackTransaction.findFirst({
    where: { reference: req.params.reference, businessId: req.auth!.businessId },
  });
  if (!transaction) return res.status(404).json({ error: "Transaction not found" });

  if (transaction.status === "PENDING") {
    const result = await finalizePaystackTransaction(transaction.reference);
    return res.json({ reference: transaction.reference, ...result });
  }

  return res.json({
    reference: transaction.reference,
    status: transaction.status === "SUCCESSFUL" ? "already_processed" : "failed",
    saleId: transaction.saleId,
  });
});

export default router;
