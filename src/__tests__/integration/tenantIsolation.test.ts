import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { hasTestDb, testPrisma } from "./setup";

// The single most important security property in a multi-tenant system:
// nothing a client sends (a body field, a query param, a guessed ID) can
// ever let it read or write another business's data — only the businessId
// embedded in that business's own verified JWT can. Every route is supposed
// to scope its queries with `businessId: req.auth.businessId`; these tests
// exercise that promise end to end rather than trusting a code review of it.
describe.skipIf(!hasTestDb)("tenant isolation", () => {
  let app: import("express").Express;
  let businessAToken: string;
  let businessBProductId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    app = (await import("../../index")).default;

    const bizA = await request(app).post("/auth/register-business").send({
      businessName: "Tenant Test A",
      ownerName: "Owner A",
      email: `tenant-a-${Date.now()}@test.local`,
      password: "password123",
    });
    businessAToken = bizA.body.accessToken;

    const bizB = await request(app).post("/auth/register-business").send({
      businessName: "Tenant Test B",
      ownerName: "Owner B",
      email: `tenant-b-${Date.now()}@test.local`,
      password: "password123",
    });
    const businessBToken = bizB.body.accessToken;

    const productB = await request(app)
      .post("/products")
      .set("Authorization", `Bearer ${businessBToken}`)
      .send({ name: "Business B's Product", sellingPrice: 10, costPrice: 5 });
    businessBProductId = productB.body.product.id;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("business A cannot fetch business B's product by ID", async () => {
    const res = await request(app)
      .get(`/products/${businessBProductId}`)
      .set("Authorization", `Bearer ${businessAToken}`);
    expect(res.status).toBe(404); // not 403 — existence itself isn't confirmed
  });

  it("business A cannot sell business B's product", async () => {
    const res = await request(app)
      .post("/sales/checkout")
      .set("Authorization", `Bearer ${businessAToken}`)
      .send({ items: [{ productId: businessBProductId, quantity: 1, discount: 0 }], paymentMethod: "CASH" });
    expect(res.status).toBe(400);
  });

  it("business A's product list never includes business B's product", async () => {
    const res = await request(app).get("/products").set("Authorization", `Bearer ${businessAToken}`);
    const ids = res.body.products.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(businessBProductId);
  });
});
