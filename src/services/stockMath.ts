import { Prisma } from "@prisma/client";

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export interface QtyLine {
  ingredientId: string;
  quantity: Prisma.Decimal.Value;
}

// Standard usage for a production run: per-unit make-up x units produced.
export function scaleComponents(components: QtyLine[], produced: Prisma.Decimal.Value) {
  const n = D(produced);
  return components.map((c) => ({ ingredientId: c.ingredientId, quantity: D(c.quantity).mul(n) }));
}

// Cost of ONE unit of a recipe: sum of (qty x ingredient cost per unit).
export function recipeCost(lines: QtyLine[], costById: Map<string, Prisma.Decimal.Value>) {
  return lines.reduce((sum, l) => sum.add(D(l.quantity).mul(D(costById.get(l.ingredientId) ?? 0))), D(0));
}

// Weighted-average cost after adding stock. Negative or zero on-hand stock
// carries no value, so the new cost is just the incoming cost.
export function weightedAverageCost(
  onHand: Prisma.Decimal.Value,
  currentCost: Prisma.Decimal.Value,
  addQty: Prisma.Decimal.Value,
  addUnitCost: Prisma.Decimal.Value
) {
  const have = D(onHand).greaterThan(0) ? D(onHand) : D(0);
  const add = D(addQty);
  const total = have.add(add);
  if (total.lessThanOrEqualTo(0)) return D(addUnitCost);
  return have.mul(D(currentCost)).add(add.mul(D(addUnitCost))).div(total);
}

// variance = counted - expected (negative = missing). Value uses unit cost.
export function countLineVariance(
  expected: Prisma.Decimal.Value,
  counted: Prisma.Decimal.Value,
  unitCost: Prisma.Decimal.Value
) {
  const variance = D(counted).sub(D(expected));
  const value = variance.mul(D(unitCost)).toDecimalPlaces(2);
  return { variance, value };
}

// Would adding component `candidateId` to prepared item `outputId` create a
// loop (dough needs dough)? `edges` maps a prepared item to its components.
export function wouldCreateCycle(
  outputId: string,
  candidateId: string,
  edges: Map<string, string[]>
): boolean {
  if (candidateId === outputId) return true;
  const seen = new Set<string>();
  const stack = [candidateId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === outputId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of edges.get(id) ?? []) stack.push(next);
  }
  return false;
}

export function toNum(v: Prisma.Decimal.Value | null | undefined) {
  return v === null || v === undefined ? 0 : Number(v);
}

// "A 50 kg bag costs GH₵650" -> GH₵13 per kg. Undefined when either part is missing.
export function costFromPack(packSize?: number, packPrice?: number): number | undefined {
  if (!packSize || packPrice === undefined) return undefined;
  return Math.round((packPrice / packSize) * 10000) / 10000;
}
