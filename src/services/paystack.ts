import crypto from "crypto";

const PAYSTACK_BASE = "https://api.paystack.co";

// Every function here takes the secret key as a parameter — there is no
// global PAYSTACK_SECRET_KEY anymore. Each business brings its own
// Paystack account (see src/services/businessPaystackKeys.ts), so a
// payment settles to THAT business's bank account, not a shared platform
// account. Callers fetch+decrypt the right key for the business/transaction
// in question before calling any of these.

// Paystack signs the raw webhook body with HMAC-SHA512 using the secret key
// of the Paystack account the transaction belongs to. This must run on the
// raw request bytes, BEFORE any JSON parsing — see how the webhook route is
// mounted with express.raw() in index.ts. The caller is responsible for
// having already determined whose secretKey to try (see
// paystackWebhook.ts's reference-lookup-before-verify flow).
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secretKey: string
): boolean {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac("sha512", secretKey).update(rawBody).digest("hex");
  // Constant-time comparison to avoid timing attacks on the signature check.
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signatureHeader, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

interface InitializeParams {
  email: string;
  amountInMainUnit: number; // e.g. 25.50 GHS
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

interface InitializeResult {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export async function initializeTransaction(
  params: InitializeParams,
  secretKey: string
): Promise<InitializeResult> {
  const response = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: params.email,
      // Paystack expects the smallest currency unit (pesewas for GHS, kobo for NGN).
      amount: Math.round(params.amountInMainUnit * 100),
      reference: params.reference,
      callback_url: params.callbackUrl,
      metadata: params.metadata,
    }),
  });

  const data: any = await response.json();
  if (!response.ok || !data.status) {
    throw new Error(`Paystack initialize failed: ${data.message || response.statusText}`);
  }
  return data.data as InitializeResult;
}

interface VerifyResult {
  status: "success" | "failed" | "abandoned" | string;
  amount: number; // in the smallest currency unit
  reference: string;
  currency: string;
  gateway_response?: string;
}

// Rule #8/#9: never trust a client-side "it succeeded" claim, and never
// trust the webhook payload's own status field either — always call this
// to independently confirm the transaction status with Paystack itself.
export async function verifyTransaction(reference: string, secretKey: string): Promise<VerifyResult> {
  const response = await fetch(
    `${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );

  const data: any = await response.json();
  if (!response.ok || !data.status) {
    throw new Error(`Paystack verify failed: ${data.message || response.statusText}`);
  }
  return data.data as VerifyResult;
}

export async function createRefund(
  params: {
    transactionReference: string;
    amountInMainUnit?: number; // omit for a full refund
  },
  secretKey: string
) {
  const response = await fetch(`${PAYSTACK_BASE}/refund`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      transaction: params.transactionReference,
      ...(params.amountInMainUnit ? { amount: Math.round(params.amountInMainUnit * 100) } : {}),
    }),
  });

  const data: any = await response.json();
  if (!response.ok || !data.status) {
    throw new Error(`Paystack refund failed: ${data.message || response.statusText}`);
  }
  return data.data;
}

// Validates the shape of a key the Owner pastes into Settings before we
// bother storing it — catches "pasted the wrong field" mistakes immediately
// rather than failing confusingly on the next real payment attempt.
export function looksLikePaystackPublicKey(key: string): boolean {
  return /^pk_(test|live)_[A-Za-z0-9]+$/.test(key);
}
export function looksLikePaystackSecretKey(key: string): boolean {
  return /^sk_(test|live)_[A-Za-z0-9]+$/.test(key);
}
