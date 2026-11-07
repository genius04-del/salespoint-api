import { describe, it, expect } from "vitest";
import { costFromPack } from "../../services/stockMath";

describe("costFromPack", () => {
  it("divides pack price by pack size", () => {
    expect(costFromPack(50, 650)).toBe(13);
    expect(costFromPack(0.5, 40)).toBe(80);
  });
  it("returns undefined when either part is missing", () => {
    expect(costFromPack(undefined, 650)).toBeUndefined();
    expect(costFromPack(50, undefined)).toBeUndefined();
  });
});
