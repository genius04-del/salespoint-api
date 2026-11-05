import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { authenticate, authorize } from "../middleware/auth";
import { recordAudit } from "../utils/audit";
import { seedDefaultChartOfAccounts } from "../services/seedAccounts";
import { accessTokenFor } from "./auth";

// Chains: one owner, several branches. Every branch is its own business (own
// stock, tills, days and books); the group only links them and adds the
// group-wide screens. A branch manager is an ordinary user of ONE branch, so
// they only ever see that branch. Only a group admin can look across.
const router = Router();
router.use(authenticate);

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

async function groupAdmin(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user && user.groupAdminId ? user : null;
}

// ---- GET /groups/me ---- who am I in the chain, and which branches exist
router.get("/me", async (req, res) => {
  const { userId, businessId } = req.auth!;
  const [admin, current] = await Promise.all([
    groupAdmin(userId),
    prisma.business.findUnique({ where: { id: businessId }, select: { id: true, name: true, branchType: true, groupId: true } }),
  ]);
  const base = {
    current: current ? { id: current.id, name: current.name, branchType: current.branchType, inGroup: !!current.groupId } : null,
  };
  if (!admin) return res.json({ ...base, isGroupAdmin: false, group: null, branches: [], canEnable: req.auth!.role === "OWNER" && !current?.groupId });
  const group = await prisma.businessGroup.findUnique({ where: { id: admin.groupAdminId! } });
  const branches = await prisma.business.findMany({
    where: { groupId: admin.groupAdminId! },
    select: { id: true, name: true, branchType: true, isActive: true },
    orderBy: { createdAt: "asc" },
  });
  return res.json({ ...base, isGroupAdmin: true, group: group ? { id: group.id, name: group.name } : null, branches, canEnable: false });
});

// ---- POST /groups/enable ---- the owner turns their business into a chain
router.post("/enable", authorize("OWNER"), async (req, res) => {
  const parsed = z.object({ name: z.string().min(2).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { userId, businessId } = req.auth!;

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) return res.status(404).json({ error: "Business not found" });
  if (business.groupId) return res.status(409).json({ error: "This business is already part of a group." });

  const group = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const g = await tx.businessGroup.create({ data: { name: parsed.data.name?.trim() || business.name } });
    await tx.business.update({ where: { id: businessId }, data: { groupId: g.id } });
    await tx.user.update({ where: { id: userId }, data: { groupAdminId: g.id, activeBusinessId: businessId } });
    return g;
  });
  await recordAudit({ businessId, userId, action: "GROUP_ENABLED", entity: "BusinessGroup", entityId: group.id });
  return res.status(201).json({ group: { id: group.id, name: group.name } });
});

// Copies the menu (categories and items, never stock) from one branch to another.
// Matches by name, so running it again updates prices instead of duplicating.
export async function copyMenu(tx: Prisma.TransactionClient, fromId: string, toId: string) {
  const [cats, products, existingCats, existingProducts] = await Promise.all([
    tx.category.findMany({ where: { businessId: fromId } }),
    tx.product.findMany({ where: { businessId: fromId } }),
    tx.category.findMany({ where: { businessId: toId } }),
    tx.product.findMany({ where: { businessId: toId } }),
  ]);
  const key = (s: string) => s.trim().toLowerCase();
  const catIdByName = new Map<string, string>(existingCats.map((c: any) => [key(c.name), c.id]));
  const catNameById = new Map<string, string>(cats.map((c: any) => [c.id, c.name]));

  for (const c of cats as any[]) {
    if (catIdByName.has(key(c.name))) continue;
    const made = await tx.category.create({ data: { businessId: toId, name: c.name, description: c.description, isActive: c.isActive } });
    catIdByName.set(key(c.name), made.id);
  }

  const byName = new Map<string, any>((existingProducts as any[]).map((p) => [key(p.name), p]));
  let created = 0;
  let updated = 0;
  for (const p of products as any[]) {
    const catName = p.categoryId ? catNameById.get(p.categoryId) : undefined;
    const categoryId = catName ? catIdByName.get(key(catName)) ?? null : null;
    const fields = {
      description: p.description,
      unit: p.unit,
      costPrice: p.costPrice,
      sellingPrice: p.sellingPrice,
      imageUrl: p.imageUrl,
      isActive: p.isActive,
      categoryId,
    };
    const match = byName.get(key(p.name));
    if (match) {
      await tx.product.update({ where: { id: match.id }, data: fields });
      updated++;
    } else {
      await tx.product.create({ data: { businessId: toId, name: p.name, sku: p.sku, barcode: p.barcode, minStockLevel: 0, currentQuantity: 0, ...fields } });
      created++;
    }
  }
  return { created, updated };
}

// ---- POST /groups/branches ---- add a branch (optionally with its manager and the menu)
const branchSchema = z.object({
  name: z.string().min(2),
  branchType: z.enum(["OUTLET", "PRODUCTION"]).default("OUTLET"),
  phone: z.string().optional(),
  address: z.string().optional(),
  copyMenu: z.boolean().default(false),
  manager: z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(8) }).optional(),
});

router.post("/branches", async (req, res) => {
  const { userId, businessId } = req.auth!;
  const admin = await groupAdmin(userId);
  if (!admin) return res.status(403).json({ error: "Only the chain owner can add branches." });
  const parsed = branchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  if (d.manager) {
    const taken = await prisma.user.findUnique({ where: { email: d.manager.email } });
    if (taken) return res.status(409).json({ error: "Someone already uses that email address." });
  }
  const source = await prisma.business.findUnique({ where: { id: businessId } });
  if (!source) return res.status(404).json({ error: "Business not found" });
  const passwordHash = d.manager ? await bcrypt.hash(d.manager.password, 12) : null;

  const result = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const branch = await tx.business.create({
        data: {
          name: d.name.trim(),
          phone: d.phone,
          address: d.address,
          businessType: source.businessType,
          currency: source.currency,
          restaurantModeEnabled: source.restaurantModeEnabled,
          requireOpenDay: source.requireOpenDay,
          requireShift: source.requireShift,
          groupId: admin.groupAdminId!,
          branchType: d.branchType,
        },
      });
      await seedDefaultChartOfAccounts(tx, branch.id);
      let manager: { id: string; name: string; email: string } | null = null;
      if (d.manager) {
        const m = await tx.user.create({
          data: { businessId: branch.id, name: d.manager.name, email: d.manager.email, passwordHash: passwordHash!, role: "MANAGER" },
        });
        manager = { id: m.id, name: m.name, email: m.email };
      }
      const menu = d.copyMenu && d.branchType === "OUTLET" ? await copyMenu(tx, businessId, branch.id) : null;
      return { branch, manager, menu };
    },
    { timeout: 60000 }
  );

  await recordAudit({ businessId, userId, action: "BRANCH_CREATED", entity: "Business", entityId: result.branch.id, metadata: { name: d.name, branchType: d.branchType } });
  return res.status(201).json({
    branch: { id: result.branch.id, name: result.branch.name, branchType: result.branch.branchType },
    manager: result.manager,
    menu: result.menu,
  });
});

// ---- POST /groups/branches/:id/sync-menu ---- make another branch's menu match THIS branch
router.post("/branches/:id/sync-menu", async (req, res) => {
  const { userId, businessId } = req.auth!;
  const admin = await groupAdmin(userId);
  if (!admin) return res.status(403).json({ error: "Only the chain owner can do this." });
  const target = await prisma.business.findFirst({ where: { id: req.params.id, groupId: admin.groupAdminId! } });
  if (!target) return res.status(404).json({ error: "Branch not found" });
  if (target.id === businessId) return res.status(400).json({ error: "Pick a different branch than the one you are in." });
  if (target.branchType === "PRODUCTION") return res.status(400).json({ error: "A production branch has no menu." });

  const menu = await prisma.$transaction((tx: Prisma.TransactionClient) => copyMenu(tx, businessId, target.id), { timeout: 60000 });
  await recordAudit({ businessId, userId, action: "MENU_SYNCED", entity: "Business", entityId: target.id, metadata: menu });
  return res.json({ menu });
});

// ---- POST /groups/switch ---- work inside another branch
router.post("/switch", async (req, res) => {
  const { userId } = req.auth!;
  const parsed = z.object({ businessId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const admin = await groupAdmin(userId);
  if (!admin) return res.status(403).json({ error: "Only the chain owner can switch branches." });
  const target = await prisma.business.findFirst({ where: { id: parsed.data.businessId, groupId: admin.groupAdminId!, isActive: true } });
  if (!target) return res.status(404).json({ error: "Branch not found" });

  const updated = await prisma.user.update({ where: { id: userId }, data: { activeBusinessId: target.id } });
  return res.json({ accessToken: accessTokenFor(updated), branch: { id: target.id, name: target.name, branchType: target.branchType } });
});

// ---- GET /groups/report?from=&to= ---- every branch side by side
router.get("/report", async (req, res) => {
  const { userId } = req.auth!;
  const admin = await groupAdmin(userId);
  if (!admin) return res.status(403).json({ error: "Only the chain owner can see the group report." });

  const parsed = z.object({ from: z.string().datetime(), to: z.string().datetime() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Send from and to as ISO dates." });
  const range = { gte: new Date(parsed.data.from), lte: new Date(parsed.data.to) };

  const branches = await prisma.business.findMany({
    where: { groupId: admin.groupAdminId! },
    select: { id: true, name: true, branchType: true },
    orderBy: { createdAt: "asc" },
  });
  const ids = branches.map((b: { id: string }) => b.id);

  const [paid, cancelled, openDays] = await Promise.all([
    prisma.sale.groupBy({
      by: ["businessId", "paymentMethod"],
      where: { businessId: { in: ids }, status: "COMPLETED", paymentStatus: "SUCCESSFUL", createdAt: range },
      _sum: { total: true },
      _count: { _all: true },
    }),
    prisma.sale.groupBy({ by: ["businessId"], where: { businessId: { in: ids }, status: "CANCELLED", createdAt: range }, _count: { _all: true } }),
    prisma.businessDay.findMany({ where: { businessId: { in: ids }, status: "OPEN" }, select: { businessId: true, openedAt: true, number: true } }),
  ]);
  const lastClosed = await Promise.all(
    ids.map((id: string) =>
      prisma.businessDay.findFirst({
        where: { businessId: id, status: "CLOSED" },
        orderBy: { closedAt: "desc" },
        select: { businessId: true, number: true, closedAt: true, totalVariance: true },
      })
    )
  );

  const rows = branches.map((b: { id: string; name: string; branchType: string }) => {
    const mine = (paid as any[]).filter((p) => p.businessId === b.id);
    const byMethod: Record<string, number> = {};
    let total = 0;
    let sales = 0;
    for (const p of mine) {
      const amount = Number(p._sum.total ?? 0);
      byMethod[p.paymentMethod] = round2((byMethod[p.paymentMethod] ?? 0) + amount);
      total += amount;
      sales += p._count._all;
    }
    const open = (openDays as any[]).find((d) => d.businessId === b.id);
    const last = (lastClosed as any[]).find((d) => d && d.businessId === b.id);
    return {
      id: b.id,
      name: b.name,
      branchType: b.branchType,
      sales,
      total: round2(total),
      byMethod,
      cancelled: (cancelled as any[]).find((c) => c.businessId === b.id)?._count._all ?? 0,
      dayOpen: open ? { number: open.number, openedAt: open.openedAt } : null,
      lastClosed: last ? { number: last.number, closedAt: last.closedAt, variance: last.totalVariance == null ? null : Number(last.totalVariance) } : null,
    };
  });

  const totals = rows.reduce(
    (t: { sales: number; total: number; byMethod: Record<string, number> }, r: { sales: number; total: number; byMethod: Record<string, number> }) => {
      for (const [m, v] of Object.entries(r.byMethod)) t.byMethod[m] = round2((t.byMethod[m] ?? 0) + v);
      return { sales: t.sales + r.sales, total: round2(t.total + r.total), byMethod: t.byMethod };
    },
    { sales: 0, total: 0, byMethod: {} as Record<string, number> }
  );
  return res.json({ rows, totals });
});

export default router;
