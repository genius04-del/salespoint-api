import { Router, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { verifyWebhookSignature } from "../services/paystack";
import { getBusinessPaystackSecretKey } from "../services/businessPaystackKeys";
import { finalizePaystackTransaction } from "../services/paystackFinalize";

const router = Router();

// Mounted in index.ts with express.raw({ type: "application/json" }) so
// req.body here is a Buffer — required for HMAC signature verification,
// which must run on the exact raw bytes Paystack sent, not a re-serialized
// JSON object. This route has no JWT auth; the signature IS the auth.
//
// Multi-tenant wrinkle: each business has its OWN Paystack secret key, so
// there's no longer one global key to check the signature against. We
// resolve this the same way Stripe Connect-style platforms do: look up
// which of OUR OWN transaction records the payload's reference belongs to
// (safe — we generated that reference ourselves, and this lookup doesn't
// trust anything else in the payload yet), which tells us which business's
// key to verify the signature with. Only once that signature check passes
// do we trust the payload and act on it.
router.post("/paystack", async (req: Request, res: Response) => {
  const signature = req.headers["x-paystack-signature"] as string | undefined;
  const rawBody = req.body as Buffer;

  let event: any;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const reference = event?.data?.reference;
  if (!signature || typeof reference !== "string") {
    return res.status(401).json({ error: "Invalid signature" });
  }

  // Looking up which business this reference belongs to — not yet trusting
  // anything about the event's contents, just resolving which secret key
  // to check the signature against.
  const transaction = await prisma.paystackTransaction.findUnique({
    where: { reference },
    select: { businessId: true },
  });
  if (!transaction) {
    // Same generic rejection whether the reference is unknown or the
    // signature is wrong — do not leak which case this is.
    return res.status(401).json({ error: "Invalid signature" });
  }

  let secretKey: string;
  try {
    secretKey = await getBusinessPaystackSecretKey(transaction.businessId);
  } catch {
    return res.status(401).json({ error: "Invalid signature" });
  }

  if (!verifyWebhookSignature(rawBody, signature, secretKey)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  // Always ACK quickly and let finalizePaystackTransaction() do the real,
  // independently-verified work — we never trust event.data.status itself,
  // only use the reference to go check with Paystack ourselves.
  if (event?.event === "charge.success") {
    try {
      await finalizePaystackTransaction(reference);
    } catch (err) {
      console.error("Error finalizing Paystack webhook:", err);
      // Still 200 — Paystack retries on non-2xx, and finalize is idempotent,
      // so a transient error here is safer to swallow than to trigger a
      // retry storm. It'll also self-heal via the status-poll endpoint.
    }
  }

  return res.status(200).json({ received: true });
});

export default router;
