import { describe, it, expect } from "vitest";
import {
  afterFailedPin, expectedShiftCash, generateBusinessCode, handoverDifference, lockMinutesLeft,
  normaliseBusinessCode, shiftVariance, validatePin, MAX_PIN_ATTEMPTS,
} from "../shifts";

describe("shift cash maths", () => {
  it("expects float plus cash sales, without float drift", () => {
    expect(expectedShiftCash(100, 0.1 + 0.2)).toBe(100.3);
  });
  it("variance is counted minus expected (negative = short)", () => {
    expect(shiftVariance(95, 100)).toEqual({ variance: -5, kind: "SHORT" });
    expect(shiftVariance(100, 100).kind).toBe("BALANCED");
    expect(shiftVariance(101.5, 100)).toEqual({ variance: 1.5, kind: "OVER" });
  });
  it("handover difference is what the next cashier found minus what was handed over", () => {
    expect(handoverDifference(480, 500)).toBe(-20);
    expect(handoverDifference(500, 500)).toBe(0);
  });
});

describe("validatePin", () => {
  it("accepts 4 to 6 digits", () => {
    expect(validatePin("4821")).toBeNull();
    expect(validatePin("482193")).toBeNull();
  });
  it("rejects wrong lengths and non-digits", () => {
    for (const bad of ["123", "1234567", "12a4", "", "12 34"]) expect(validatePin(bad)).not.toBeNull();
  });
  it("rejects obvious guesses", () => {
    for (const bad of ["0000", "1111", "1234", "4321", "123456", "654321"]) expect(validatePin(bad)).not.toBeNull();
  });
});

describe("PIN lockout", () => {
  it("counts failures and locks on the fifth", () => {
    let failures = 0;
    for (let i = 1; i < MAX_PIN_ATTEMPTS; i++) {
      const r = afterFailedPin(failures);
      expect(r.locked).toBe(false);
      failures = r.pinFailedAttempts;
    }
    const last = afterFailedPin(failures, new Date("2026-11-01T10:00:00Z"));
    expect(last.locked).toBe(true);
    expect(last.pinLockedUntil!.toISOString()).toBe("2026-11-01T10:10:00.000Z");
    expect(last.pinFailedAttempts).toBe(0);
  });
  it("reports minutes left, rounding up, and zero once expired", () => {
    const now = new Date("2026-11-01T10:00:00Z");
    expect(lockMinutesLeft(new Date("2026-11-01T10:04:10Z"), now)).toBe(5);
    expect(lockMinutesLeft(new Date("2026-11-01T09:59:00Z"), now)).toBe(0);
    expect(lockMinutesLeft(null, now)).toBe(0);
  });
});

describe("business code", () => {
  it("is 6 characters from an unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) expect(generateBusinessCode()).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
  });
  it("accepts a code typed with spaces, dashes and lower case", () => {
    expect(normaliseBusinessCode(" ab3-k9 x ")).toBe("AB3K9X");
  });
});
