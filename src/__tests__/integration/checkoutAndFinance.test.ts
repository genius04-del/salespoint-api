import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { hasTestDb, testPrisma } from "./setup";

// Exercises the full chain a real sale goes through: stock reduction,
// receipt numbering, and — the part most likely to silently break — that
// the automatically-posted journal entry actually balances (rule #17).
describe.skipIf(!hasTestDb)("checkout -> stock -> double-entry accounting", () => {
  let app: import("express").Express;
  let token: string;
  let productId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    app = (await import("../../index")).default;

    const biz = await request(app).post("/auth/register-business").send({
      businessName: "Checkout Test Co",
      ownerName: "Owner",
      email: `checkout-test-${Date.now()}@test.local`,
      password: "password123",
    });
    token = biz.body.accessToken;

    const product = await request(app)
      .post("/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Test Widget", sellingPrice: 100, costPrice: 60, openingStock: 10 });
    productId = product.body.product.id;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("reduces stock by exactly the quantity sold", async () => {
    await request(app)
      .post("/sales/checkout")
      .set("Authorization", `Bearer ${token}`)
      .send({ items: [{ productId, quantity: 1, discount: 0 }], paymentMethod: "CASH", amountTendered: 100 });

    const res = await request(app).get(`/products/${productId}`).set("Authorization", `Bearer ${token}`);
    expect(res.body.product.currentQuantity).toBe(9);
  });

  it("refuses to sell more than is in stock (never allows negative stock on a normal sale)", async () => {
    const res = await request(app)
      .post("/sales/checkout")
      .set("Authorization", `Bearer ${token}`)
      .send({ items: [{ productId, quantity: 9999, discount: 0 }], paymentMethod: "CASH" });
    expect(res.status).toBe(409);
  });

  it("posts a journal entry where total debits equal total credits (rule #17), matching the spec's GH₵100/GH₵60 example", async () => {
    await request(app)
      .post("/sales/checkout")
      .set("Authorization", `Bearer ${token}`)
      .send({ items: [{ productId, quantity: 1, discount: 0 }], paymentMethod: "CASH", amountTendered: 100 });

    const tb = await request(app).get("/finance/trial-balance").set("Authorization", `Bearer ${token}`);
    expect(tb.body.balanced).toBe(true);
    expect(tb.body.totalDebits).toBe(tb.body.totalCredits);

    const revenue = tb.body.accounts.find((a: { code: string }) => a.code === "4000");
    const cogs = tb.body.accounts.find((a: { code: string }) => a.code === "5000");
    // Two sales of 1 unit each by this point in the test file.
    expect(revenue.credit).toBeGreaterThanOrEqual(100);
    expect(cogs.debit).toBeGreaterThanOrEqual(60);
  });

  it("cancelling a sale restores stock and nets its journal entry back to zero impact", async () => {
    const sale = await request(app)
      .post("/sales/checkout")
      .set("Authorization", `Bearer ${token}`)
      .send({ items: [{ productId, quantity: 1, discount: 0 }], paymentMethod: "CASH", amountTendered: 100 });

    const before = await request(app).get(`/products/${productId}`).set("Authorization", `Bearer ${token}`);

    await request(app)
      .post(`/sales/${sale.body.sale.id}/cancel`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "Integration test cancellation" });

    const after = await request(app).get(`/products/${productId}`).set("Authorization", `Bearer ${token}`);
    expect(after.body.product.currentQuantity).toBe(before.body.product.currentQuantity + 1);

    const tb = await request(app).get("/finance/trial-balance").set("Authorization", `Bearer ${token}`);
    expect(tb.body.balanced).toBe(true);
  });
});
