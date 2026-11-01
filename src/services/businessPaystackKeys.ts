import { prisma } from "../config/prisma";
import { decrypt } from "./encryption";

export class PaystackNotConfiguredError extends Error {
  constructor() {
    super("Paystack is not set up for this business yet. Add your Paystack keys in Settings first.");
    this.name = "PaystackNotConfiguredError";
  }
}

// The ONLY place a business's Paystack secret key is decrypted. Every
// Paystack API call (initialize, verify, refund) and the webhook's
// signature check go through this — never read paystackSecretKeyEncrypted
// or call decrypt() directly anywhere else.
export async function getBusinessPaystackSecretKey(businessId: string): Promise<string> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { paystackSecretKeyEncrypted: true },
  });
  if (!business?.paystackSecretKeyEncrypted) {
    throw new PaystackNotConfiguredError();
  }
  return decrypt(business.paystackSecretKeyEncrypted);
}
