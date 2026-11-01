import { describe, it, expect } from "vitest";
import { effectivePermissions, ROLE_DEFAULTS, ALL_PERMISSIONS } from "../permissions";

describe("effectivePermissions", () => {
  it("gives an Owner every permission, regardless of overrides", () => {
    const perms = effectivePermissions("OWNER", [], ["sales.create", "finance.view"]);
    expect(perms.sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it("returns exactly a role's defaults with no overrides", () => {
    expect(effectivePermissions("CASHIER").sort()).toEqual(
      [...ROLE_DEFAULTS.CASHIER].sort()
    );
  });

  it("adds a granted permission not already in the role's defaults", () => {
    const perms = effectivePermissions("CASHIER", ["reports.view"], []);
    expect(perms).toContain("reports.view");
    expect(perms).toContain("sales.create"); // still has its defaults
  });

  it("removes a revoked permission that WAS in the role's defaults", () => {
    const perms = effectivePermissions("CASHIER", [], ["customers.manage"]);
    expect(perms).not.toContain("customers.manage");
  });

  it("KITCHEN_STAFF gets the kitchen plus production and counting, but no approval or finance", () => {
    const perms = effectivePermissions("KITCHEN_STAFF");
    expect(perms.sort()).toEqual(["kitchen.manage", "stock.count", "stock.produce", "stock.view"]);
    expect(perms).not.toContain("stock.approve");
  });

  it("ignores an unknown permission string instead of throwing", () => {
    const perms = effectivePermissions("CASHIER", ["not.a.real.permission" as any], []);
    expect(perms).not.toContain("not.a.real.permission");
  });

  it("grant and revoke of the same permission: revoke wins (net removed)", () => {
    // Defensive check on the combination logic itself — routes additionally
    // reject grant/revoke overlap before it reaches this function.
    const perms = effectivePermissions("MANAGER", ["staff.manage"], ["staff.manage"]);
    expect(perms).not.toContain("staff.manage");
  });

  it("day end: cashiers can open and view but NOT close; managers can do all three", () => {
    const cashier = effectivePermissions("CASHIER");
    expect(cashier).toContain("day.view");
    expect(cashier).toContain("day.open");
    expect(cashier).not.toContain("day.close");
    const manager = effectivePermissions("MANAGER");
    expect(manager).toEqual(expect.arrayContaining(["day.view", "day.open", "day.close"]));
  });

  it("day end: an accountant can view but not open or close", () => {
    const acc = effectivePermissions("ACCOUNTANT");
    expect(acc).toContain("day.view");
    expect(acc).not.toContain("day.open");
    expect(acc).not.toContain("day.close");
  });
});
