import "server-only";
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Plain, printable PDFs (daily logs, minutes, punch lists) with pdf-lib: free,
 * no service, runs in the function. Letter size, Helvetica, the house ink.
 */

export interface PdfSection {
  heading: string;
  /** Start this section on a new page (e.g. one page per project). */
  breakBefore?: boolean;
  /** Show the heading as a title (with an optional line under it) rather than a small label. */
  title?: { subtitle?: string };
  /** Label / value pairs. */
  rows?: [string, string][];
  paragraphs?: string[];
  table?: { columns: string[]; widths?: number[]; rows: string[][] };
}

export interface PdfDocInput {
  title: string;
  subtitle?: string;
  meta?: string;
  sections: PdfSection[];
  footer?: string;
}

const INK = rgb(0.13, 0.12, 0.11);
const MUTED = rgb(0.42, 0.4, 0.37);
const RULE = rgb(0.85, 0.83, 0.8);
const PAGE = { w: 612, h: 792, margin: 54 };

/** The standard fonts only encode WinAnsi: map common typography and drop what can't print. */
export function pdfSafe(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/→/g, "->")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of pdfSafe(text).split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        if (line) out.push(line);
        // A single over-long word is cut to fit.
        let w = word;
        while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
          let cut = w.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
          out.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

export async function renderPdf(input: PdfDocInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(input.title));
  doc.setProducer("Project Command");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const width = PAGE.w - PAGE.margin * 2;
  let page: PDFPage = doc.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - PAGE.margin;

  const newPage = () => {
    page = doc.addPage([PAGE.w, PAGE.h]);
    y = PAGE.h - PAGE.margin;
  };
  const need = (h: number) => {
    if (y - h < PAGE.margin + 24) newPage();
  };
  const text = (s: string, x: number, size: number, font: PDFFont, color = INK) => page.drawText(pdfSafe(s), { x, y, size, font, color });

  need(60);
  text(input.title, PAGE.margin, 18, bold);
  y -= 22;
  if (input.subtitle) {
    text(input.subtitle, PAGE.margin, 11, regular, MUTED);
    y -= 15;
  }
  if (input.meta) {
    text(input.meta, PAGE.margin, 9, regular, MUTED);
    y -= 13;
  }
  y -= 6;
  page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.w - PAGE.margin, y }, thickness: 0.75, color: RULE });
  y -= 18;

  for (const s of input.sections) {
    if (s.breakBefore && y < PAGE.h - PAGE.margin) newPage();
    need(40);
    if (s.title) {
      for (const l of wrap(s.heading, bold, 15, width)) {
        text(l, PAGE.margin, 15, bold);
        y -= 19;
      }
      if (s.title.subtitle) {
        for (const l of wrap(s.title.subtitle, regular, 10, width)) {
          text(l, PAGE.margin, 10, regular, MUTED);
          y -= 13;
        }
      }
      y -= 8;
    } else {
      text(s.heading.toUpperCase(), PAGE.margin, 9, bold, MUTED);
      y -= 14;
    }
    for (const [label, value] of s.rows ?? []) {
      const lines = wrap(value || "-", regular, 10, width - 150);
      // Keep short values together; a long one (a full day's notes) flows on to the next page line by line.
      need(Math.min(lines.length, 4) * 13 + 2);
      text(label, PAGE.margin, 10, bold);
      lines.forEach((l, i) => {
        if (i > 0 && y - 13 < PAGE.margin + 24) {
          newPage();
          text(`${label} (continued)`, PAGE.margin, 10, bold, MUTED);
        }
        text(l, PAGE.margin + 150, 10, regular);
        y -= 13;
      });
      y -= 2;
    }
    for (const p of s.paragraphs ?? []) {
      for (const l of wrap(p, regular, 10, width)) {
        need(13);
        text(l, PAGE.margin, 10, regular);
        y -= 13;
      }
      y -= 4;
    }
    if (s.table) {
      const cols = s.table.columns;
      const widths = s.table.widths ?? cols.map(() => width / cols.length);
      const drawRow = (cells: string[], font: PDFFont, color = INK) => {
        const wrapped = cells.map((c, i) => wrap(c || "", font, 9, widths[i]! - 6));
        const tall = Math.max(1, ...wrapped.map((w) => w.length));
        need(Math.min(tall, 4) * 11 + 4);
        // A row taller than what's left of the page continues on the next one instead of running off the bottom.
        for (let from = 0; from < tall; ) {
          if (from > 0) newPage();
          const fit = Math.max(1, Math.floor((y - PAGE.margin - 24 - 4) / 11));
          const to = Math.min(tall, from + fit);
          let x = PAGE.margin;
          const top = y;
          wrapped.forEach((lines, i) => {
            let yy = top;
            for (const l of lines.slice(from, to)) {
              page.drawText(l, { x, y: yy, size: 9, font, color });
              yy -= 11;
            }
            x += widths[i]!;
          });
          y = top - (to - from) * 11 - 4;
          from = to;
        }
        page.drawLine({ start: { x: PAGE.margin, y: y + 6 }, end: { x: PAGE.w - PAGE.margin, y: y + 6 }, thickness: 0.4, color: RULE });
      };
      drawRow(cols, bold, MUTED);
      for (const r of s.table.rows) drawRow(r, regular);
    }
    y -= 12;
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const foot = pdfSafe(`${input.footer ? `${input.footer} - ` : ""}Page ${i + 1} of ${pages.length}`);
    p.drawText(foot, { x: PAGE.margin, y: PAGE.margin - 20, size: 8, font: regular, color: MUTED });
  });
  return doc.save();
}

export function pdfResponse(bytes: Uint8Array, filename: string): Response {
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]+/g, "-")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
