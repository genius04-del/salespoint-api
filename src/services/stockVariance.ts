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

// ---------------------------------------------------------------------------
// Period report: opening -> in/out/waste -> theoretical closing -> actual
// closing -> variance, per item.
//
// "Theoretical closing" is what the system says should be on the shelf if
// nothing went missing; "actual closing" is what is there after the physical
// counts were approved. The difference is the variance, i.e. the count
// adjustments. An item that was never counted in the period has no actual
// closing and no variance.
// ---------------------------------------------------------------------------

export interface ReportItem {
  itemType: "PRODUCT" | "INGREDIENT";
  itemId: string;
  name: string;
  unit: string;
  category: string | null;
  currentQuantity: Prisma.Decimal.Value;
  unitCost: Prisma.Decimal.Value;
}

export interface ReportMovement {
  itemId: string;
  kind: "COUNT" | "WASTE" | "OTHER"; // COUNT = a stock-count adjustment, WASTE = written off / damaged
  change: Prisma.Decimal.Value; // signed
  previous: Prisma.Decimal.Value;
  next: Prisma.Decimal.Value;
  at: Date;
}

export interface MovementReportRow {
  itemType: "PRODUCT" | "INGREDIENT";
  itemId: string;
  name: string;
  unit: string;
  category: string | null;
  opening: number;
  stockIn: number;
  stockOut: number;
  waste: number;
  theoreticalClosing: number;
  actualClosing: number | null;
  variance: number | null; // negative = missing
  varianceValue: number | null;
  counted: boolean;
}

const r3 = (d: Prisma.Decimal) => d.toDecimalPlaces(3).toNumber();

export function buildMovementReport(
  items: ReportItem[],
  movements: ReportMovement[],
  countedItemIds: Set<string>,
  from: Date,
  to: Date
): MovementReportRow[] {
  const byItem = new Map<string, ReportMovement[]>();
  movements.forEach((m) => {
    if (m.at < from) return; // only what happened from the start of the period on matters
    byItem.set(m.itemId, [...(byItem.get(m.itemId) ?? []), m]);
  });

  const rows: MovementReportRow[] = [];
  for (const item of items) {
    const all = (byItem.get(item.itemId) ?? []).slice().sort((a, b) => a.at.getTime() - b.at.getTime());
    const inRange = all.filter((m) => m.at <= to);
    // Quantity at the start of the period: what the first movement started from,
    // or, if nothing has moved since, what is on the shelf now.
    const opening = all.length ? D(all[0].previous) : D(item.currentQuantity);
    const closing = inRange.length ? D(inRange[inRange.length - 1].next) : opening;

    let stockIn = D(0);
    let stockOut = D(0);
    let waste = D(0);
    let countAdj = D(0);
    for (const m of inRange) {
      const c = D(m.change);
      if (m.kind === "COUNT") countAdj = countAdj.add(c);
      else if (m.kind === "WASTE") waste = waste.add(c.abs());
      else if (c.isNegative()) stockOut = stockOut.add(c.abs());
      else stockIn = stockIn.add(c);
    }

    const counted = countedItemIds.has(item.itemId);
    if (!counted && inRange.length === 0 && opening.isZero()) continue; // nothing to report

    const variance = counted ? countAdj : null;
    rows.push({
      itemType: item.itemType,
      itemId: item.itemId,
      name: item.name,
      unit: item.unit,
      category: item.category,
      opening: r3(opening),
      stockIn: r3(stockIn),
      stockOut: r3(stockOut),
      waste: r3(waste),
      theoreticalClosing: r3(closing.sub(countAdj)),
      actualClosing: counted ? r3(closing) : null,
      variance: variance ? r3(variance) : counted ? 0 : null,
      varianceValue: variance ? variance.mul(D(item.unitCost)).toDecimalPlaces(2).toNumber() : counted ? 0 : null,
      counted,
    });
  }
  return rows.sort(
    (a, b) => (a.category ?? "~").localeCompare(b.category ?? "~") || a.name.localeCompare(b.name)
  );
}
