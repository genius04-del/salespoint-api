export interface DateRange {
  from: Date;
  to: Date;
  label: string;
}

const DAY_MS = 86_400_000;

// Ghana runs on GMT (UTC+0) with no daylight saving, so UTC day boundaries
// are the same as local day boundaries. If SalesPoint later supports other
// time zones, this is the one place that needs to learn about them.
const startOfDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const endOfDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));

// Supports: range=today | week | month | year | custom (with from & to).
// Week starts on Monday. Date-only custom values (YYYY-MM-DD) cover whole days.
// Throws Error("INVALID_DATE_RANGE") on bad input.
export function resolveDateRange(
  query: { range?: unknown; from?: unknown; to?: unknown },
  defaultRange = "today"
): DateRange {
  const now = new Date();
  const range = String(query.range ?? defaultRange);

  switch (range) {
    case "today":
      return { from: startOfDay(now), to: endOfDay(now), label: "today" };

    case "week": {
      const daysSinceMonday = (now.getUTCDay() + 6) % 7;
      return {
        from: startOfDay(new Date(now.getTime() - daysSinceMonday * DAY_MS)),
        to: endOfDay(now),
        label: "week",
      };
    }

    case "month":
      return {
        from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        to: endOfDay(now),
        label: "month",
      };

    case "year":
      return {
        from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
        to: endOfDay(now),
        label: "year",
      };

    case "custom": {
      if (!query.from || !query.to) throw new Error("INVALID_DATE_RANGE");
      const fromRaw = String(query.from);
      const toRaw = String(query.to);
      const from = new Date(fromRaw);
      const to = new Date(toRaw);
      if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new Error("INVALID_DATE_RANGE");
      const range = {
        from: fromRaw.length <= 10 ? startOfDay(from) : from,
        to: toRaw.length <= 10 ? endOfDay(to) : to,
        label: "custom",
      };
      if (range.from > range.to) throw new Error("INVALID_DATE_RANGE");
      return range;
    }

    default:
      throw new Error("INVALID_DATE_RANGE");
  }
}
