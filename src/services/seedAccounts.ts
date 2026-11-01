import { Prisma } from "@prisma/client";
import { ACCOUNT_CODES } from "./journal";

interface SeedAccount {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
}

// Rule #16's default chart of accounts. isSystem=true on every one of
// these — they're never deletable, only renamable/deactivatable, since
// journal automation (src/services/journal.ts) looks them up by code.
const DEFAULT_ACCOUNTS: SeedAccount[] = [
  { code: ACCOUNT_CODES.CASH, name: "Cash", type: "ASSET", normalBalance: "DEBIT" },
  { code: ACCOUNT_CODES.BANK, name: "Bank", type: "ASSET", normalBalance: "DEBIT" },
  { code: ACCOUNT_CODES.MOBILE_MONEY, name: "Mobile Money", type: "ASSET", normalBalance: "DEBIT" },
  { code: ACCOUNT_CODES.PAYSTACK_CLEARING, name: "Paystack Clearing", type: "ASSET", normalBalance: "DEBIT" },
  { code: ACCOUNT_CODES.INVENTORY, name: "Inventory", type: "ASSET", normalBalance: "DEBIT" },
  { code: ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, name: "Accounts Receivable", type: "ASSET", normalBalance: "DEBIT" },
  { code: ACCOUNT_CODES.ACCOUNTS_PAYABLE, name: "Accounts Payable", type: "LIABILITY", normalBalance: "CREDIT" },
  { code: ACCOUNT_CODES.OTHER_PAYABLES, name: "Other Payables", type: "LIABILITY", normalBalance: "CREDIT" },
  { code: ACCOUNT_CODES.OWNER_CAPITAL, name: "Owner Capital", type: "EQUITY", normalBalance: "CREDIT" },
  { code: ACCOUNT_CODES.RETAINED_EARNINGS, name: "Retained Earnings", type: "EQUITY", normalBalance: "CREDIT" },
  { code: ACCOUNT_CODES.SALES_REVENUE, name: "Sales Revenue", type: "REVENUE", normalBalance: "CREDIT" },
  { code: ACCOUNT_CODES.OTHER_INCOME, name: "Other Income", type: "REVENUE", normalBalance: "CREDIT" },
  { code: ACCOUNT_CODES.COST_OF_GOODS_SOLD, name: "Cost of Goods Sold", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: ACCOUNT_CODES.RENT, name: "Rent", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: ACCOUNT_CODES.UTILITIES, name: "Utilities", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: ACCOUNT_CODES.TRANSPORT, name: "Transport", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: ACCOUNT_CODES.SALARIES, name: "Salaries", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: ACCOUNT_CODES.ADVERTISING, name: "Advertising", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: ACCOUNT_CODES.INTERNET, name: "Internet", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: ACCOUNT_CODES.REPAIRS, name: "Repairs", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: ACCOUNT_CODES.OTHER_EXPENSES, name: "Other Expenses", type: "EXPENSE", normalBalance: "DEBIT" },
];

export async function seedDefaultChartOfAccounts(tx: Prisma.TransactionClient, businessId: string) {
  await tx.account.createMany({
    data: DEFAULT_ACCOUNTS.map((a) => ({ ...a, businessId, isSystem: true })),
  });
}
