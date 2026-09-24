import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { renderPdf } from "@/server/services/pdf";

describe("PDF rendering", () => {
  it("a long value or table cell flows onto new pages instead of running off the bottom", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ").repeat(2);
    const rows = await PDFDocument.load(await renderPdf({ title: "Log", sections: [{ heading: "Day", rows: [["Work performed", long]] }] }));
    expect(rows.getPageCount()).toBeGreaterThan(1);
    const table = await PDFDocument.load(await renderPdf({ title: "Punch", sections: [{ heading: "Items", table: { columns: ["#", "Item"], widths: [30, 120], rows: [["1", long]] } }] }));
    expect(table.getPageCount()).toBeGreaterThan(1);
    const short = await PDFDocument.load(await renderPdf({ title: "Short", sections: [{ heading: "Day", rows: [["Crew", "12"]] }] }));
    expect(short.getPageCount()).toBe(1);
  });
});
