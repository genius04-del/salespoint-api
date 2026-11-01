import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";

// ENCRYPTION_KEY must be set before encryption.ts is imported, since
// getKey() reads it at call time but the module itself has no top-level
// side effects that would need it earlier — setting it in beforeAll is
// still the clearest way to make this test file self-contained.
beforeAll(() => {
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
});

describe("encryption", () => {
  it("round-trips a Paystack secret key exactly", async () => {
    const { encrypt, decrypt } = await import("../encryption");
    const secret = "sk_test_abcdef1234567890";
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it("produces different ciphertext each time (random IV) even for the same input", async () => {
    const { encrypt } = await import("../encryption");
    const a = encrypt("sk_test_same_value");
    const b = encrypt("sk_test_same_value");
    expect(a).not.toBe(b);
  });

  it("rejects a tampered ciphertext instead of silently returning garbage", async () => {
    const { encrypt, decrypt } = await import("../encryption");
    const encrypted = encrypt("sk_test_abcdef1234567890");
    const bytes = Buffer.from(encrypted, "base64");
    bytes[bytes.length - 1] ^= 0xff; // flip a bit in the ciphertext
    const tampered = bytes.toString("base64");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("fails to decrypt with the wrong key (simulating a lost/rotated ENCRYPTION_KEY)", async () => {
    const { encrypt, decrypt } = await import("../encryption");
    const encrypted = encrypt("sk_test_abcdef1234567890");
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    expect(() => decrypt(encrypted)).toThrow();
  });
});
