import { describe, it, expect } from "vitest";
import { isRestaurantType } from "../businessType";

describe("isRestaurantType", () => {
  it("treats restaurants and bars as restaurant businesses", () => {
    for (const t of ["restaurant", "Restaurant", "bar", "Pizza Inn", "chop bar", "cafe", "Kitchen"]) expect(isRestaurantType(t)).toBe(true);
  });
  it("does not treat shops as restaurant businesses", () => {
    for (const t of ["provision_store", "mini_mart", "clothing", "cosmetics", "electronics", "general", "", null, undefined]) expect(isRestaurantType(t as never)).toBe(false);
  });
});
