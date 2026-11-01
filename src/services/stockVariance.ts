import { Prisma } from "@prisma/client";

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export interface CountLineRow {
  itemType: "PRODUCT" | "INGREDIENT";
  productId: string | null;
  ingredientId: string | null;
  itemName: string;
  unit: string;
  variance: Prisma.Decimal.Value | null;
  varianceValue: Prisma.Decimal.Value | null;
  countedAt: Date;
}

export interface VarianceItem {
  itemType: "PRODUCT" | "INGREDIENT";
  itemId: string;
  name: string;
  unit: string;
  timesCounted: number;
  timesShort: number;
  totalVariance: number; // negative = missing
  totalValue: number;
}

// Rolls approved-count lines up per item, worst loss first.
export function rollUpCountVariance(rows: CountLineRow[]): VarianceItem[] {
  const map = new Map<string, VarianceItem & { _v: Prisma.Decimal; _val: Prisma.Decimal }>();
  for (const r of rows) {
    if (r.variance === null) continue;
    const id = r.itemType === "PRODUCT" ? r.productId : r.ingredientId;
    const key = `${r.itemType}:${id ?? r.itemName}`;
    let e = map.get(key);
    if (!e) {
      e = {
        itemType: r.itemType, itemId: id ?? "", name: r.itemName, unit: r.unit,
        timesCounted: 0, timesShort: 0, totalVariance: 0, totalValue: 0, _v: D(0), _val: D(0),
      };
      map.set(key, e);
    }
    const v = D(r.variance);
    e.timesCounted += 1;
    if (v.isNegative()) e.timesShort += 1;
    e._v = e._v.add(v);
    e._val = e._val.add(D(r.varianceValue ?? 0));
  }
  return [...map.values()]
    .map(({ _v, _val, ...rest }) => ({ ...rest, totalVariance: _v.toNumber(), totalValue: _val.toDecimalPlaces(2).toNumber() }))
    .filter((i) => i.totalVariance !== 0)
    .sort((a, b) => a.totalValue - b.totalValue); // most negative (biggest loss) first
}

export function summariseCountVariance(items: VarianceItem[]) {
  let loss = D(0);
  let gain = D(0);
  for (const i of items) {
    if (i.totalValue < 0) loss = loss.add(i.totalValue);
    else gain = gain.add(i.totalValue);
  }
  return {
    loss: loss.toNumber(),
    gain: gain.toNumber(),
    net: loss.add(gain).toDecimalPlaces(2).toNumber(),
  };
}

export interface BatchLineRow {
  ingredientId: string;
  name: string;
  unit: string;
  quantityUsed: Prisma.Decimal.Value;
  standardQuantity: Prisma.Decimal.Value;
  unitCost: Prisma.Decimal.Value;
}

// Positive overUse = more went into production than the standard make-up said.
export function rollUpProductionUsage(rows: BatchLineRow[]) {
  const map = new Map<string, { ingredientId: string; name: string; unit: string; used: Prisma.Decimal; standard: Prisma.Decimal; value: Prisma.Decimal }>();
  for (const r of rows) {
    if (D(r.standardQuantity).isZero()) continue; // no standard to compare against
    const e = map.get(r.ingredientId) ?? { ingredientId: r.ingredientId, name: r.name, unit: r.unit, used: D(0), standard: D(0), value: D(0) };
    const used = D(r.quantityUsed);
    const std = D(r.standardQuantity);
    e.used = e.used.add(used);
    e.standard = e.standard.add(std);
    e.value = e.value.add(used.sub(std).mul(D(r.unitCost)));
    map.set(r.ingredientId, e);
  }
  return [...map.values()]
    .map((e) => ({
      ingredientId: e.ingredientId, name: e.name, unit: e.unit,
      used: e.used.toNumber(), standard: e.standard.toNumber(),
      overUse: e.used.sub(e.standard).toNumber(), value: e.value.toDecimalPlaces(2).toNumber(),
    }))
    .filter((e) => e.overUse !== 0)
    .sort((a, b) => b.value - a.value);
}
