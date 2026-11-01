import { describe, it, expect } from "vitest";
import { toCsv } from "../csv";

describe("toCsv", () => {
  it("produces a header row and one row per record", () => {
    const csv = toCsv([{ a: 1, b: "x" }, { a: 2, b: "y" }]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("a,b");
    expect(lines[1]).toBe("1,x");
    expect(lines[2]).toBe("2,y");
  });

  it("returns an empty string for no rows", () => {
    expect(toCsv([])).toBe("");
  });

  it("quotes a value containing a comma", () => {
    expect(toCsv([{ name: "Smith, John" }])).toContain('"Smith, John"');
  });

  it("escapes an embedded double-quote by doubling it", () => {
    expect(toCsv([{ note: 'He said "hi"' }])).toContain('"He said ""hi"""');
  });

  // Formula-injection protection: a product/customer name a user typed
  // that starts with = + - @ could execute as a formula when the CSV is
  // opened in Excel. A leading apostrophe neutralizes that.
  it("prefixes a leading '=' with an apostrophe (formula injection)", () => {
    expect(toCsv([{ name: "=cmd|'/c calc'" }])).toContain("'=cmd");
  });

  it("prefixes a leading '+', '-', and '@' the same way", () => {
    expect(toCsv([{ name: "+1234" }])).toContain("'+1234");
    expect(toCsv([{ name: "-1234" }])).toContain("'-1234");
    expect(toCsv([{ name: "@SUM(A1)" }])).toContain("'@SUM(A1)");
  });

  it("does NOT prefix a normal name or a real number", () => {
    const csv = toCsv([{ name: "Coca-Cola 50cl", total: 8 }]);
    expect(csv).toContain("Coca-Cola 50cl");
    expect(csv).not.toContain("'Coca-Cola");
    expect(csv).toContain(",8");
  });

  it("renders null/undefined as an empty cell", () => {
    expect(toCsv([{ a: null, b: undefined }])).toBe("a,b\n,");
  });
});
