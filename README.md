# SalesPoint Backend — Phase 10+ (multi-tenant Paystack)

Multi-tenant POS & business management backend. Built in phases per
the SalesPoint spec's phased build order — this drop covers Phases 1
through 10 — the full build order from the spec:
architecture/auth, products/inventory, POS/sales,
customers/suppliers/purchases, Paystack payments, finance
(Chart of Accounts, double-entry, ledger, expenses), reports/dashboard, staff permissions/audit logs, an
optional restaurant/kitchen module, and production hardening.

## Stack

- Node.js + TypeScript + Express
- PostgreSQL + Prisma ORM
- JWT auth (short-lived access token + 30-day refresh token), bcrypt password hashing
- Zod for request validation
- helmet + cors for basic hardening

## Setup

1. Copy `.env.example` to `.env` and fill in a real `DATABASE_URL`
   (a Postgres instance — Supabase's Postgres works fine here) and two
   long random strings for `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`.
2. `npm install`
3. `npm run prisma:migrate` — creates all tables from `prisma/schema.prisma`.
4. `npm run dev` — starts the API on `http://localhost:4000`.
5. For Phase 5 (Paystack): also fill in `PAYSTACK_SECRET_KEY` (test key
   from your Paystack dashboard) and `PAYSTACK_CALLBACK_URL`. To receive
   webhooks locally, use a tunnel (e.g. `ngrok http 4000`) and set the
   Paystack dashboard's webhook URL to `https://<your-tunnel>/webhooks/paystack`.
6. For Phase 6 (Finance): if your business was registered before this
   phase, call `POST /accounts/seed-defaults` once (as the Owner) to
   backfill the Chart of Accounts — new businesses get it automatically now.

## What's implemented

**Phase 1 — Auth, business, staff**
- `POST /auth/register-business` — onboarding: creates a business +
  its first user as OWNER in one transaction.
- `POST /auth/login`, `POST /auth/refresh`, `GET /auth/me`
- `GET/PATCH /business` — business settings (PATCH is owner-only)
- `GET/POST/PATCH /staff` — staff management, scoped to the caller's
  own business only (owner/manager only for create/update)

**Phase 2 — Products, categories, inventory**
- `GET/POST/PATCH/DELETE /categories` — DELETE is blocked if products
  still reference the category
- `GET/POST/PATCH/DELETE /products` — search by name/sku/barcode,
  filter by category; DELETE deactivates instead of hard-deleting
  once a product has any inventory history
- `POST /inventory/movements` — manual stock changes (ADJUSTMENT,
  DAMAGE, RETURN, OPENING_STOCK, TRANSFER); PURCHASE/SALE movements
  will be created automatically by later modules, not through this
  endpoint
- `GET /inventory/movements` — history, optional `?productId=`
- `GET /inventory/low-stock` — products at or below their minimum
  stock level
- `src/services/inventory.ts` — `applyInventoryMovement()` is the
  ONLY code path allowed to change `Product.currentQuantity`; it
  always runs inside a transaction alongside the movement record, and
  refuses to take stock below zero unless explicitly overridden. Every
  later module that touches stock (purchases, POS/sales, refunds)
  should call this same function rather than updating the product
  directly.

**Phase 3 — POS / Sales / Receipts**
- `POST /sales/checkout` — the core POS flow: validates stock and product
  status, computes totals, atomically generates a sequential receipt
  number per business, creates the Sale + SaleItems, and reduces stock
  for every line via `applyInventoryMovement()` — all in one transaction.
- Accepts `CASH`, `MOBILE_MONEY`, `BANK_TRANSFER`, `OTHER` and confirms
  them immediately (the cashier is directly handling the payment).
  **`PAYSTACK` is explicitly rejected for now** with a clear message —
  marking it successful without real backend verification would violate
  the payment-integrity rule (#8/#9); that lands properly in Phase 5.
- `GET /sales` — list with `from`/`to`/`cashierId` filters
- `GET /sales/:id` — full detail with line items
- `GET /sales/:id/receipt` — structured receipt data (business info,
  items, totals, payment) ready for a client to render/print/share
- `POST /sales/:id/cancel` — Owner/Manager only. Never deletes the sale
  (rule #22) — flips `status`/`paymentStatus` and creates compensating
  `RETURN` inventory movements to restore stock, fully auditable.

**Phase 4 — Customers, Suppliers, Purchases**
- `GET/POST/PATCH/DELETE /customers` — search by name/phone, purchase
  history via linked sales. Deliberately **no stored balance/wallet
  field** (rule #12/#49) — a customer is never a source of held funds.
- `GET/POST/PATCH/DELETE /suppliers` — `outstandingBalance` is always
  computed from `purchase.totalCost - amountPaid` across their
  purchases, never stored as an editable number, so it can't drift out
  of sync.
- `POST /purchases` — records stock coming in: creates the Purchase +
  PurchaseItems and increases stock for every line via the same
  `applyInventoryMovement()` choke point sales/opening-stock use.
  Supports an optional initial payment at purchase time.
- `GET /purchases`, `GET /purchases/:id` — filters by supplier/date
- `POST /purchases/:id/payments` — records a payment toward the
  balance (Owner/Manager/Accountant only); `amountPaid`/`paymentStatus`
  are only ever updated by adding a payment row, never edited directly
- `sales.customerId` is now optional on checkout — a sale can be tied
  to a customer for purchase history, still works with no customer
  (walk-in)

**Phase 5 — Payments / Paystack / verification / webhooks**
- `POST /payments/paystack/initialize` — prices the cart (reusing the
  same `priceSaleItems()` sales/checkout uses), calls Paystack to open
  a transaction, and stores a `PaystackTransaction` row with the
  **would-be sale captured in `payload`** — nothing touches stock or
  the receipt counter yet. Returns an `authorizationUrl` for the
  customer to pay at.
- `POST /webhooks/paystack` — the real completion path. Verifies the
  `X-Paystack-Signature` HMAC against the raw request body (mounted
  with `express.raw()` ahead of the global JSON parser in `index.ts`
  specifically so the raw bytes are available), then hands off to...
- `src/services/paystackFinalize.ts` — `finalizePaystackTransaction()`
  is the **only** place a `PaystackTransaction` becomes a `Sale`.
  It never trusts the webhook payload's own status field — it always
  calls Paystack's `verify` endpoint itself first (rule #8/#9). It
  uses a compare-and-swap update (`status: PENDING` → `SUCCESSFUL`)
  so two concurrent calls — a real webhook plus a status-poll
  self-heal, or a duplicate webhook delivery — can never both create
  a sale for the same reference (duplicate-callback protection).
- `GET /payments/paystack/:reference/status` — the cashier UI can poll
  this while the customer pays; if still `PENDING` it calls the same
  finalize function itself, so a missed/delayed webhook self-heals.
- If stock changed between initialize and payment completion and
  there's not enough left, the sale is still created (money's already
  been collected — rule #34 says detect and reconcile, never hide it)
  with `paymentStatus: UNRECONCILED` and an audit log flag, rather
  than either blocking a paid customer or silently overselling.
- `POST /sales/:id/cancel`, extended: if the sale was paid via
  Paystack, this now calls Paystack's refund API **first** — if that
  fails, the whole cancellation aborts (no stock reversal without a
  confirmed refund). On success, `paymentStatus` is set to `REFUNDED`
  instead of `REVERSED`.
- Paystack secrets only ever live in `.env` on the server — never sent
  to or read from the frontend.

**Phase 6 — Finance (Chart of Accounts, double-entry, ledger, expenses)**
- **`POST /accounts/seed-defaults`** — run this once if your business
  was registered before this phase (yours was). It seeds the default
  Chart of Accounts (Cash, Bank, Mobile Money, Paystack Clearing,
  Inventory, Accounts Receivable/Payable, Owner Capital, Sales
  Revenue, COGS, and expense categories like Rent/Utilities/Salaries —
  rule #16). Businesses registered from now on get this automatically
  at signup.
- `GET/POST/PATCH /accounts` — view the chart, add custom accounts;
  a **system account's type/normalBalance/code can never be changed**
  since journal automation looks accounts up by fixed code.
- `src/services/journal.ts` — `createJournalEntry()` is the **only**
  function allowed to write a `JournalEntry`. It resolves every line's
  account by code and refuses to save anything where total debits ≠
  total credits (rule #17) — an unbalanced entry is a thrown error,
  never a silently-accepted row.
- **Financial automation** — nothing here requires a human to type in
  a number; every one of these posts inside the same DB transaction
  as the business event that caused it:
  - Checkout / Paystack finalize → Debit payment account, Credit Sales
    Revenue; if the product carried a cost, also Debit COGS / Credit
    Inventory (gross profit recognized automatically, matching the
    spec's worked example in rule #17)
  - Sale cancellation → the exact reverse, as a new compensating entry
    (rule #22), using each `SaleItem`'s frozen `unitCost` so a later
    change to a product's cost price can never retroactively change
    historical COGS
  - Purchase recorded → Debit Inventory / Credit Accounts Payable for
    the full cost; an initial payment (if any) immediately posts a
    second entry reducing that payable
  - `POST /purchases/:id/payments` → Debit Accounts Payable / Credit
    whichever payment account was used
  - `POST /expenses` → Debit the chosen expense category / Credit the
    payment account, in one entry, atomically with the `Expense` record
- `GET /finance/ledger/:accountId` — chronological entries for one
  account with a running balance (rule #52's "Basic Ledger"), filterable by date
- `GET /finance/trial-balance` — every account's balance as of now (or
  a given date), with `totalDebits`/`totalCredits`/`balanced` — this
  is the sanity check that the double-entry has stayed internally
  consistent the whole time
- Full Profit & Loss, Balance Sheet, and the financial Dashboard are
  Phase 7 (Reports/Dashboard) — this phase is the accounting
  *foundation* those reports will read from, not the reports themselves.

- Every protected route reads `businessId` from the verified JWT
  (`req.auth.businessId`) — never from the request body/params — so
  tenant isolation can't be bypassed by a client sending a different
  business ID.
- `audit_logs` table + `recordAudit()` helper, wired into business
  creation, login, staff, category, product, stock-adjustment,
  sale/cancellation, customer, supplier, purchase, account, and
  expense actions.

## Roles and permissions

Roles: `OWNER`, `MANAGER`, `CASHIER`, `INVENTORY_OFFICER`, `ACCOUNTANT`,
`KITCHEN_STAFF`. Each role has a default set of permissions
(`src/services/permissions.ts`), and routes check *permissions* rather
than role names. The defaults reproduce the access each role had before
permissions existed. The Owner can then grant or revoke individual
permissions per person (see Phase 8 below).

**Phase 8 — Staff permissions, logout & audit log**
- **Granular permissions.** There are 19 permissions (`sales.create`,
  `sales.cancel`, `products.manage`, `finance.view`, `reports.view`,
  `audit.view`, and so on). A user's effective permissions are: role
  defaults + granted extras - revoked ones. An Owner always has all of
  them and can't be restricted, so an owner can't be locked out.
- `GET /staff/permissions` — the catalogue with descriptions, and each
  role's defaults.
- `GET /staff/:id/permissions` — one person's defaults, overrides and
  effective permissions.
- `PUT /staff/:id/permissions` — **Owner only.** Body:
  `{ "grant": ["reports.view"], "revoke": ["customers.manage"] }`. Replaces
  that person's overrides. Every change is written to the audit log with
  before/after values (`PERMISSIONS_CHANGED`).
- The access token now carries the user's permissions. A permission change
  takes effect when their next token is issued (they log in again, or within
  15 minutes). Old tokens without a permission list fall back to role
  defaults, so existing sessions keep working.
- `GET /auth/me` now also returns `permissions`, so the app can hide screens
  the user can't use.
- **Logout.** `POST /auth/logout` revokes every refresh token the account
  has (a `tokenVersion` on the user is bumped) and writes `LOGOUT` to the
  audit log. The current access token stays valid until it expires (max 15
  minutes) — inherent to stateless JWTs — so clients should discard it.
  Logging out signs the account out everywhere.
- **Audit log viewer.** `GET /audit-logs` (needs `audit.view`, which only the
  Owner has by default). Filters: `userId`, `action`, `entity`, `entityId`,
  and a date range (`range=today|week|month|year` or `from`/`to`);
  paging with `limit`/`page`; `&format=csv` to download.
  `GET /audit-logs/actions` lists the distinct action names.
  There is deliberately no route anywhere that edits or deletes audit
  records. Database-level protection against tampering is planned for
  Phase 10 (security hardening).

**Phase 9 — Restaurant/Kitchen mode (optional)**
Off by default (rule #26 — a provision store should never see this). Turn
it on with `PATCH /business { "restaurantModeEnabled": true }` (Owner
only). Every `/tables` and `/orders` route returns a 400 telling you to do
this until it's on.
- `GET/POST/PATCH /tables` — `tables.manage` to create/edit; anyone who can
  sell can view them.
- **`POST /orders`** — opens a tab: optional `tableId`, `items: [{productId,
  quantity, notes}]`. Stock is reduced **immediately**, one movement per
  item — food service consumes ingredients on preparation, not on eventual
  payment, unlike retail's pay-then-reduce-stock flow. Sets the table to
  `OCCUPIED`.
- `GET /orders`, `GET /orders/:id` — filter by `status`/`tableId`.
- `POST /orders/:id/items` — add more items (another round) to an order
  that's still `OPEN`; same stock-on-add behavior.
- **`PATCH /orders/items/:itemId/status`** (`kitchen.manage`) — the ticket
  workflow: `NEW → PREPARING → READY → SERVED`, or `CANCELLED` if the
  kitchen can't make it — which reverses just that item's stock and
  nothing else on the order.
- `POST /orders/:id/cancel` — voids the whole tab before payment, reverses
  stock for every item not already individually cancelled, frees the table.
- **`POST /orders/:id/checkout`** — pays the tab. This is where an `Order`
  becomes a real `Sale`, going through the exact same receipt numbering and
  `postSaleJournalEntry()` accounting every other checkout uses — it does
  **not** call `applyInventoryMovement()` again, since stock was already
  committed when the items were added. Paystack isn't wired in for dine-in
  yet — cash, mobile money, and bank transfer only, same as `/sales/checkout`
  before Phase 5's webhook flow existed.
- `KITCHEN_STAFF`'s only permission is `kitchen.manage` (rule #26 — "access
  only to Kitchen orders, order status"), matching the role table's original
  intent.

**Phase 10 — Security, testing, performance, deployment**
- **Rate limiting** (`src/middleware/rateLimit.ts`): a general limiter on
  every route, and a stricter one (20 attempts / 15 min, keyed by
  IP+email) on `/auth/login`, `/auth/register-business`, `/auth/refresh`,
  `/auth/forgot-password`, `/auth/reset-password` — the endpoints a
  credential-stuffing attack actually targets.
- **CORS locked down for production.** Set `ALLOWED_ORIGINS` (comma-separated)
  to your frontend's real origin(s). The app now **refuses to start in
  production** without it, rather than silently defaulting to wide open.
  In development, with nothing set, everything is still allowed.
- **Fail-fast startup checks** (`checkRequiredEnv()` in `src/index.ts`):
  missing secrets, identical access/refresh secrets, or (in production)
  JWT secrets under 32 characters all stop the app from starting, instead
  of running in a silently-insecure state.
- **Self-service password.** `POST /auth/change-password` (needs the
  current password) and a full forgot/reset flow
  (`POST /auth/forgot-password` → `POST /auth/reset-password`) using a
  hashed, 30-minute, single-use token — closes the gap flagged back in
  Phase 8. **No email provider is wired up yet** — the reset link is
  logged to the server console instead (search for `[password reset]`).
  Wire in a real provider (Resend, SendGrid, etc.) before real users
  rely on this; the token mechanism itself is production-ready.
  Both a password change and a completed reset revoke every other
  session on the account (`tokenVersion` bump), the same way logout does.
  **Email is now wired up** via Resend (`src/services/email.ts`) — set
  `RESEND_API_KEY` and `RESEND_FROM_EMAIL` and the reset link actually
  gets emailed. With no API key set, it degrades gracefully: the link is
  still logged to the console and the generic response is unchanged, so
  the whole flow stays testable with zero email setup. This couldn't be
  live-tested in this sandbox (no network access to `api.resend.com`,
  same limitation as Paystack) — test it with a real key on your machine.
  `RESEND_FROM_EMAIL` left unset uses Resend's `onboarding@resend.dev`
  sender, which only delivers to the email your own Resend account is
  registered with — fine for your own testing, not for real staff until
  you verify a domain.
- **Body size limits** (1 MB) on JSON and the raw webhook body; **compression**
  for responses; **`trust proxy`** set so rate limiting sees the real client
  IP behind a reverse proxy; **graceful shutdown** on SIGTERM/SIGINT so an
  in-flight request isn't dropped mid-transaction when the host restarts
  the process for a deploy.
- **A real test suite**, split in two:
  - `npm test` — 31 unit tests for pure logic (permission calculation,
    date-range resolution, CSV formula-injection escaping, and profit/loss
    math including the spec's own GH₵100/GH₵60 worked example from rule
    #17). These need no database and **were actually run in this sandbox** —
    every one passes for real, not just reviewed.
  - `npm run test:integration` — tenant isolation and the full
    checkout→stock→double-entry-accounting chain, using a real Postgres
    database via `supertest`. These need network access this sandbox
    doesn't have, so they're written and type-checked but not yet
    executed — see `src/__tests__/integration/README.md` for how to run
    them yourself against a disposable test database.
  - **One real bug was caught along the way**: `round2()` (used everywhere
    money is displayed) misrounded values like 1.005 down to 1.00, a
    classic floating-point representation issue. Fixed and covered by a
    regression test.
- **`Dockerfile`** (multi-stage build) + **`.dockerignore`** for deploying
  to Render/Railway/Fly/any container host. Runs `prisma migrate deploy`
  automatically on container start.


## Post-MVP — Multi-tenant Paystack (one Paystack account per business)

**The problem this fixes:** Phase 5 originally used one global
`PAYSTACK_SECRET_KEY` for every business on the platform — meaning every
customer's payment, from every restaurant, landed in a single shared
Paystack account instead of each business's own bank account. Fine for
one pilot business, wrong for a real multi-tenant platform.

**What changed:**
- `Business` now has its own `paystackPublicKey` and
  `paystackSecretKeyEncrypted` columns. The secret key is **AES-256-GCM
  encrypted** (`src/services/encryption.ts`) before it's ever written to
  the database, using a new required `ENCRYPTION_KEY` env var. It is
  **never** returned by any API response — not to the Owner, not
  anywhere — the same write-only pattern as a password. Losing
  `ENCRYPTION_KEY` makes every stored key unrecoverable, so back it up
  somewhere safe outside the database.
- `GET/PUT/DELETE /business/paystack-settings` (Owner only) — the Owner
  signs up for their own free Paystack account, verifies their own bank
  account with Paystack, and pastes their keys in here. `PUT` validates
  the key *shapes* (`pk_`/`sk_` prefixes) and catches a classic mistake —
  pairing a test public key with a live secret key or vice versa — before
  ever storing anything.
- Every Paystack API call (`src/services/paystack.ts`: initialize, verify,
  refund) now takes the secret key as a **parameter** — there is no
  global key left to accidentally fall back to.
  `src/services/businessPaystackKeys.ts` is the one place that
  fetches+decrypts a business's key, called right before each use.
- **The webhook was the genuinely hard part.** A signature can't be
  checked without knowing which business's secret key to check it
  against — but normally you'd read that from the payload, which you
  haven't verified yet. The fix (the same approach Stripe Connect-style
  platforms use): parse out just the `reference` first — safe, since we
  generated that reference ourselves and aren't yet trusting anything
  else in the payload — look up which of *our own* `PaystackTransaction`
  records it belongs to, resolve that business's key, and only then
  verify the signature. An unknown reference or a bad signature both get
  the same generic rejection, so neither case leaks information about
  which is true.
- `GET /business` was quietly returning **every** column, including the
  encrypted secret key blob — `paystackSecretKeyEncrypted` was never read
  by the frontend, but it was there in the HTTP response for anyone to
  look at. Fixed by giving every business query in `business.ts` an
  explicit `select`, so a new sensitive column added later can't leak the
  same way without someone deliberately adding it to that list.
- **Tested for real** (`src/services/__tests__/encryption.test.ts`, no
  database needed): a round-trip, that two encryptions of the same value
  never produce identical ciphertext, that a single flipped bit in the
  ciphertext fails to decrypt rather than returning silently-corrupted
  data, and that decrypting with the wrong key fails outright. 35/35 unit
  tests pass.

## Not built (post-MVP, per the spec's own roadmap)

Balance Sheet and cash-flow
statements, PDF export, Paystack checkout for dine-in orders, table
reservations, priced food modifiers, refresh-token rotation, and
database-level audit-log immutability (there's currently no route that
edits/deletes audit records, but nothing stops a direct database
write — that would need a DB trigger or row-level security policy).
Multi-branch, multi-warehouse, payroll, and everything else on the
spec's V1.1+ roadmap.

## Note on this sandbox

`prisma generate` couldn't download its query-engine binary in this
sandboxed environment (no network access to `binaries.prisma.sh`), so
full Prisma types weren't available for a local type-check here. On
your machine, with normal internet access, `npm run prisma:generate`
(also run automatically by `npm install` in a real environment) will
produce complete types — nothing in the code depends on the sandbox
limitation.

Similarly, this sandbox has no network access to `api.paystack.co`,
so the Paystack integration in Phase 5 couldn't be live-tested here —
only reviewed and type-checked. Test it on your machine with a
Paystack **test** secret key first.
