import "dotenv/config";
import express from "express";
import "express-async-errors"; // makes errors thrown in async route handlers reach the error middleware instead of crashing the process
import cors from "cors";
import helmet from "helmet";
import compression from "compression";

import authRoutes from "./routes/auth";
import businessRoutes from "./routes/business";
import userRoutes from "./routes/users";
import categoryRoutes from "./routes/categories";
import productRoutes from "./routes/products";
import inventoryRoutes from "./routes/inventory";
import salesRoutes from "./routes/sales";
import customerRoutes from "./routes/customers";
import supplierRoutes from "./routes/suppliers";
import purchaseRoutes from "./routes/purchases";
import paymentRoutes from "./routes/payments";
import paystackWebhookRoutes from "./routes/paystackWebhook";
import accountRoutes from "./routes/accounts";
import expenseRoutes from "./routes/expenses";
import financeRoutes from "./routes/finance";
import reportRoutes from "./routes/reports";
import auditLogRoutes from "./routes/auditLogs";
import tableRoutes from "./routes/tables";
import orderRoutes from "./routes/orders";
import dayRoutes from "./routes/days";
import salesMixRoutes from "./routes/salesMix";
import ingredientRoutes from "./routes/ingredients";
import recipeRoutes from "./routes/recipes";
import productionRoutes from "./routes/production";
import stockCountRoutes from "./routes/stockCounts";
import stockVarianceRoutes from "./routes/stockVariance";
import { authenticate } from "./middleware/auth";
import groupRoutes from "./routes/groups";
import { requireOpenDay } from "./middleware/requireOpenDay";
import { requireOpenShift } from "./middleware/requireOpenShift";
import pinAuthRoutes from "./routes/pinAuth";
import tillAccessRoutes from "./routes/tillAccess";
import shiftRoutes from "./routes/shifts";
import { apiLimiter, authLimiter } from "./middleware/rateLimit";
import { prisma } from "./config/prisma";

// Fail fast on boot if anything security-critical is missing or looks like
// a placeholder — better than discovering it from a production incident.
function checkRequiredEnv() {
  const required = ["DATABASE_URL", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "ENCRYPTION_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
  if (process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
    throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values");
  }
  // ENCRYPTION_KEY protects every business's Paystack secret key at rest —
  // fail at boot if it's the wrong size rather than failing confusingly on
  // the first attempt to save or use a Paystack key.
  if (Buffer.from(process.env.ENCRYPTION_KEY as string, "base64").length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY must decode to exactly 32 bytes (256 bits). Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  if (process.env.NODE_ENV === "production") {
    for (const key of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"] as const) {
      if ((process.env[key] as string).length < 32) {
        throw new Error(`${key} is too short for production use — generate a long random value`);
      }
    }
    if (!process.env.ALLOWED_ORIGINS) {
      throw new Error(
        "ALLOWED_ORIGINS must be set in production (comma-separated list of allowed frontend origins) — refusing to start with CORS open to every origin"
      );
    }
  }
}
checkRequiredEnv();

const app = express();

// Behind a reverse proxy (Render, Railway, Fly, etc.) this makes req.ip the
// real client IP instead of the proxy's — rate limiting is meaningless without it.
app.set("trust proxy", 1);

app.use(helmet());
app.use(compression());

// In production, only the origins listed in ALLOWED_ORIGINS (comma-separated)
// may call this API. In development, with nothing set, everything is
// allowed — convenient for local testing, and checkRequiredEnv() above
// refuses to boot in production without this set explicitly.
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);
app.use(
  cors(
    allowedOrigins
      ? {
          origin: (origin, callback) => {
            // No Origin header = server-to-server or curl/Postman — allow (webhooks bypass CORS anyway).
            if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
            return callback(new Error("Not allowed by CORS"));
          },
        }
      : undefined
  )
);

app.use(apiLimiter);

// IMPORTANT: the Paystack webhook needs the raw request bytes to verify
// the HMAC signature, so it's mounted with express.raw() BEFORE the global
// express.json() below. Its route handler always sends a response itself,
// so the request never falls through to express.json() afterwards.
app.use("/webhooks", express.raw({ type: "application/json", limit: "1mb" }), paystackWebhookRoutes);

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/auth/login", authLimiter);
app.use("/auth/register-business", authLimiter);
app.use("/auth/refresh", authLimiter);
app.use("/auth/forgot-password", authLimiter);
app.use("/auth/reset-password", authLimiter);

// Optional "business day must be open" gate (only active when the Owner turns
// on requireOpenDay). Runs before the routers below, for the endpoints that
// start a sale or take money. Existing behaviour is unchanged when it's off.
app.post("/sales/checkout", authenticate, requireOpenDay);
app.post("/payments/paystack/initialize", authenticate, requireOpenDay);
app.post("/orders", authenticate, requireOpenDay);
app.post("/orders/:id/items", authenticate, requireOpenDay);

// Optional "cashier must have an open shift" gate (only active when the Owner
// turns on requireShift). Cash is taken at checkout and when a tab is paid.
app.post("/sales/checkout", authenticate, requireOpenShift);
app.post("/payments/paystack/initialize", authenticate, requireOpenShift);
app.post("/orders/:id/checkout", authenticate, requireOpenShift);

// Till (PIN) login. Mounted before /auth so it never reaches the password routes.
app.use("/auth/pin-login", pinAuthRoutes);

app.use("/auth", authRoutes);
app.use("/groups", groupRoutes);
app.use("/business", businessRoutes);
app.use("/staff", userRoutes);
app.use("/categories", categoryRoutes);
app.use("/products", productRoutes);
app.use("/inventory", inventoryRoutes);
app.use("/sales", salesRoutes);
app.use("/customers", customerRoutes);
app.use("/suppliers", supplierRoutes);
app.use("/purchases", purchaseRoutes);
app.use("/payments", paymentRoutes);
app.use("/accounts", accountRoutes);
app.use("/expenses", expenseRoutes);
app.use("/finance", financeRoutes);
app.use("/reports/sales-mix", salesMixRoutes);
app.use("/reports", reportRoutes);
app.use("/audit-logs", auditLogRoutes);
app.use("/tables", tableRoutes);
app.use("/orders", orderRoutes);
app.use("/days", dayRoutes);
app.use("/till-access", tillAccessRoutes);
app.use("/shifts", shiftRoutes);
app.use("/ingredients", ingredientRoutes);
app.use("/recipes", recipeRoutes);
app.use("/production", productionRoutes);
app.use("/stock-counts", stockCountRoutes);
app.use("/stock-variance", stockVarianceRoutes);

// Centralized error handler — keeps stack traces out of API responses.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const server = app.listen(PORT, () => {
  console.log(`SalesPoint API listening on port ${PORT} (${process.env.NODE_ENV ?? "development"})`);
});

// Graceful shutdown: stop accepting new connections, let in-flight requests
// finish, then close the database pool — avoids dropping a mid-transaction
// request when the host restarts/redeploys the process.
async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down gracefully...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  // Don't hang forever if a connection won't close.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
