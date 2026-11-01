import crypto from "crypto";

// AES-256-GCM: the standard, authenticated encryption used for secrets that
// must be stored (not just hashed, like a password) because we need the
// plaintext back later to call Paystack's API. GCM gives us both
// confidentiality AND tamper-detection (the auth tag) — a corrupted or
// edited ciphertext fails to decrypt rather than silently returning garbage.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV is the recommended size for GCM
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("ENCRYPTION_KEY is not set in the environment");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes (256 bits) — generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
  }
  return key;
}

// Stored format: base64(iv [12 bytes] + authTag [16 bytes] + ciphertext).
// Keeping everything needed to decrypt in one string keeps the DB schema
// simple — one column, not three.
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decrypt(stored: string): string {
  const buffer = Buffer.from(stored, "base64");
  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
