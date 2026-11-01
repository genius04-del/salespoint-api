import crypto from "crypto";
import { round2, computeVariance, classifyVariance } from "./dayClose";

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in __tests__/shifts.test.ts
// ---------------------------------------------------------------------------

// Cash that SHOULD be in the cashier's drawer: the float they started with
// plus the cash they took. (Card/MoMo never sit in the drawer.)
export function expectedShiftCash(openingFloat: number, cashSales: number) {
  return round2(openingFloat + cashSales);
}

export function shiftVariance(counted: number, expected: number) {
  const variance = computeVariance(counted, expected);
  return { variance, kind: classifyVariance(variance) };
}

// Incoming float minus what the outgoing cashier said they left.
// Negative = the next cashier found LESS than was handed over.
export function handoverDifference(incomingFloat: number, outgoingCounted: number) {
  return round2(incomingFloat - outgoingCounted);
}

// 4 to 6 digits, and not something a guesser tries first.
export function validatePin(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return "A PIN is 4 to 6 digits.";
  if (/^(\d)\1+$/.test(pin)) return "Choose a PIN that isn't all the same digit.";
  const asc = "0123456789";
  const desc = "9876543210";
  if (asc.includes(pin) || desc.includes(pin)) return "Choose a PIN that isn't a simple run like 1234.";
  return null;
}

export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 10;

export function lockMinutesLeft(lockedUntil: Date | null | undefined, now = new Date()) {
  if (!lockedUntil) return 0;
  const ms = lockedUntil.getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 60_000) : 0;
}

// What to store after a wrong PIN.
export function afterFailedPin(previousFailures: number, now = new Date()) {
  const failures = previousFailures + 1;
  if (failures >= MAX_PIN_ATTEMPTS) {
    return { pinFailedAttempts: 0, pinLockedUntil: new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000), locked: true };
  }
  return { pinFailedAttempts: failures, pinLockedUntil: null as Date | null, locked: false };
}

// No 0/O or 1/I/L, so a code read out loud or from a sticker is hard to mix up.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function generateBusinessCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function normaliseBusinessCode(input: string) {
  return input.trim().toUpperCase().replace(/[\s-]/g, "");
}

// Roles allowed to use the quick PIN login. Owners and managers can approve
// counts and see finance, so they always use their full password.
export const PIN_ROLES = ["CASHIER", "KITCHEN_STAFF"] as const;
