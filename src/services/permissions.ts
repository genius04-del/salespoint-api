// The catalogue of things a user can be allowed to do. Routes check these
// (via requirePermission) instead of hard-coding role names, so the Owner can
// tailor access per person — e.g. let one cashier also view reports — without
// inventing new roles.
export const PERMISSIONS = {
  "sales.create": "Ring up sales at the POS (cash and Paystack checkout)",
  "sales.view": "View sales history, sale details and receipts",
  "sales.cancel": "Cancel or refund a completed sale",
  "products.manage": "Add, edit, deactivate and delete products and categories",
  "inventory.view": "View stock movement history and the low-stock list",
  "inventory.manage": "Record stock adjustments, damages and returns",
  "customers.manage": "Add, edit and view customers",
  "suppliers.view": "View suppliers and what is owed to them",
  "suppliers.manage": "Add, edit and delete suppliers",
  "purchases.view": "View recorded purchases",
  "purchases.manage": "Record purchases (stock coming in from suppliers)",
  "purchases.pay": "Record payments made to suppliers",
  "expenses.manage": "Record and view expenses",
  "finance.view": "View the chart of accounts, ledger and trial balance",
  "accounts.manage": "Add and edit accounts in the chart of accounts",
  "reports.view": "View the dashboard and the sales, profit, expense and payment reports",
  "reports.stock": "View the inventory and purchase reports",
  "staff.manage": "Add staff, change roles, and activate or deactivate accounts",
  "audit.view": "View the audit log",
  "tables.manage": "Add, edit and deactivate tables (restaurant mode)",
  "kitchen.manage": "View kitchen tickets and update their status (restaurant mode)",
  "day.view": "See the current business day and your own sales totals for it",
  "day.open": "Open the business day (start of trading)",
  "day.close": "Count the drawer, compare with the system and close the day (cash-up)",
  "shift.use": "Open and close your own cashier shift and hand over the till",
  "shift.open_for": "Open a cashier's shift for them (when they have no PIN or forgot it)",
  "shift.view": "See every cashier's shifts, counts and handover differences",
  "stock.view": "View ingredients, recipes, the production journal, stock counts and variance reports",
  "stock.manage": "Add ingredients, set recipes, receive and write off ingredient stock",
  "stock.produce": "Record production runs in the stock journal (dough, chopped veg, sauces)",
  "stock.count": "Start, fill in and submit daily stock counts",
  "stock.approve": "Approve or reject stock counts (adjusts stock and books the loss or gain)",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

// What each role can do by default. These reproduce exactly the access the
// roles had before granular permissions existed (nothing was widened), except
// audit.view, which is Owner-only until the Owner grants it to someone.
export const ROLE_DEFAULTS: Record<string, Permission[]> = {
  OWNER: [...ALL_PERMISSIONS],
  MANAGER: [
    "sales.create", "sales.view", "sales.cancel",
    "products.manage", "inventory.view", "inventory.manage",
    "customers.manage",
    "suppliers.view", "suppliers.manage",
    "purchases.view", "purchases.manage", "purchases.pay",
    "expenses.manage", "finance.view",
    "reports.view", "reports.stock",
    "staff.manage",
    "tables.manage", "kitchen.manage",
    "day.view", "day.open", "day.close",
    "stock.view", "stock.manage", "stock.produce", "stock.count", "stock.approve",
    "shift.use", "shift.view", "shift.open_for",
  ],
  CASHIER: ["sales.create", "sales.view", "customers.manage", "day.view", "day.open", "shift.use"],
  INVENTORY_OFFICER: [
    "products.manage", "inventory.view", "inventory.manage",
    "suppliers.view", "suppliers.manage",
    "purchases.view", "purchases.manage",
    "reports.stock",
    "stock.view", "stock.manage", "stock.produce", "stock.count",
  ],
  ACCOUNTANT: [
    "sales.view", "inventory.view",
    "suppliers.view", "purchases.view", "purchases.pay",
    "expenses.manage", "finance.view", "accounts.manage",
    "reports.view", "reports.stock",
    "day.view",
    "stock.view",
    "shift.view",
  ],
  KITCHEN_STAFF: ["kitchen.manage", "stock.view", "stock.produce", "stock.count"],
};

// role defaults + the user's granted extras - the user's revoked ones.
// An Owner always has everything, so an owner can never be locked out.
export function effectivePermissions(
  role: string,
  extra: string[] = [],
  revoked: string[] = []
): Permission[] {
  if (role === "OWNER") return [...ALL_PERMISSIONS];
  const set = new Set<string>(ROLE_DEFAULTS[role] ?? []);
  for (const p of extra) if (p in PERMISSIONS) set.add(p);
  for (const p of revoked) set.delete(p);
  return ALL_PERMISSIONS.filter((p) => set.has(p));
}
