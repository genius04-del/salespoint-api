import { describe, it, expect } from "vitest";
import { resolveDateRange } from "../dateRange";

describe("resolveDateRange", () => {
  it("'today' spans exactly midnight to 23:59:59.999 UTC", () => {
    const { from, to } = resolveDateRange({ range: "today" });
    expect(from.getUTCHours()).toBe(0);
    expect(from.getUTCMinutes()).toBe(0);
    expect(to.getUTCHours()).toBe(23);
    expect(to.getUTCMinutes()).toBe(59);
    expect(to.getTime() - from.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it("'week' starts on a Monday", () => {
    const { from } = resolveDateRange({ range: "week" });
    expect(from.getUTCDay()).toBe(1); // 0=Sunday, 1=Monday
  });

  it("'month' starts on the 1st of the current month", () => {
    const { from } = resolveDateRange({ range: "month" });
    expect(from.getUTCDate()).toBe(1);
  });

  it("'year' starts on Jan 1st", () => {
    const { from } = resolveDateRange({ range: "year" });
    expect(from.getUTCMonth()).toBe(0);
    expect(from.getUTCDate()).toBe(1);
  });

  it("'custom' with date-only values covers whole days inclusive", () => {
    const { from, to } = resolveDateRange({ range: "custom", from: "2026-01-01", to: "2026-01-31" });
    expect(from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-01-31T23:59:59.999Z");
  });

  it("rejects 'custom' with from after to", () => {
    expect(() => resolveDateRange({ range: "custom", from: "2026-02-01", to: "2026-01-01" })).toThrow(
      "INVALID_DATE_RANGE"
    );
  });

  it("rejects 'custom' missing from/to", () => {
    expect(() => resolveDateRange({ range: "custom" })).toThrow("INVALID_DATE_RANGE");
  });

  it("rejects an unrecognized range value", () => {
    expect(() => resolveDateRange({ range: "fortnight" })).toThrow("INVALID_DATE_RANGE");
  });

  it("falls back to the given default when no range is specified", () => {
    const a = resolveDateRange({}, "month");
    const b = resolveDateRange({ range: "month" });
    expect(a.from.toISOString()).toBe(b.from.toISOString());
  });
});
