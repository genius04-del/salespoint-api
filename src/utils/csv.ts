import { Response } from "express";

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);

  // Product/customer/supplier names are user-typed. A cell starting with
  // = + - @ can be executed as a formula when the CSV is opened in Excel,
  // so text values get a leading apostrophe. Real numbers are left alone.
  if (typeof value === "string" && /^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }

  if (/[",\n\r]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = rows.map((row) => headers.map((h) => escapeCell(row[h])).join(","));
  return [headers.join(","), ...lines].join("\n");
}

export function sendCsv(res: Response, filename: string, rows: Record<string, unknown>[]) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(toCsv(rows));
}
