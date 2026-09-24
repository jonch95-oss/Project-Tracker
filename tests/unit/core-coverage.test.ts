/**
 * Edge cases for the M10–M12 core modules (directory, units, waterfall
 * helpers, forms, files, import parsers, inbound mail), so every branch
 * that decides what a person sees or what gets saved is pinned down.
 */
import { describe, expect, it } from "vitest";
import { mean, median, phaseDurations, suggestDurations } from "@/core/analytics";
import { canonicalJson } from "@/core/audit";
import { COI_CATEGORIES, docCategoryLabel, docState, isValidDocCategory, lapsedCoiKinds, websiteUrl } from "@/core/directory";
import { cleanDisplayName, fileExtension, formatFileSize, normalizeContentType, previewKind, storedContentType } from "@/core/files";
import { centsToInput, optionalPercentBps, optionalSignedMoney } from "@/core/forms";
import { buildCalendar } from "@/core/ics";
import { buildTemplateParts, guessMapping, parseCsv, sheetFromGrid, validateRows, zipUnpackedSize } from "@/core/import";
import { emailAddressOf, headerValues, htmlToText, inboundKeyFor, inboundKeyFromRecipient, parseInboundPayload, senderAuthenticated, signWebhook, verifyWebhookSignature } from "@/core/inbound";
import { pricePerSf, selectionState } from "@/core/units";
import { describeTiers, quarterBounds, quarterOf } from "@/core/waterfall";

describe("directory", () => {
  it("labels and validates document categories", () => {
    expect(docCategoryLabel("license", "gc_license")).toBe("GC license");
    expect(docCategoryLabel("w9", "w9")).toBe("W-9");
    expect(docCategoryLabel("nope", "x")).toBe("x");
    expect(docCategoryLabel("license", "unknown")).toBe("unknown");
    expect(isValidDocCategory("coi", COI_CATEGORIES[0]!.key)).toBe(true);
    expect(isValidDocCategory("coi", "gc_license")).toBe(false);
    expect(isValidDocCategory("bogus", "w9")).toBe(false);
    expect(COI_CATEGORIES.every((c) => !c.label.startsWith("Vendor COI"))).toBe(true);
  });

  it("document state and lapsed COIs (only the newest of each kind counts)", () => {
    expect(docState(null, "2026-09-24")).toBe("none");
    expect(docState("2026-01-01", "2026-09-24")).toBe("expired");
    const kind = COI_CATEGORIES[0]!.key;
    const other = COI_CATEGORIES[1]!.key;
    const docs = [
      { kind: "coi", category: kind, expiresOn: "2026-01-01" },
      { kind: "coi", category: kind, expiresOn: "2027-01-01" },
      { kind: "coi", category: kind, expiresOn: "2025-06-01" },
      { kind: "coi", category: other, expiresOn: "2026-02-01" },
      { kind: "coi", category: other, expiresOn: null },
      { kind: "license", category: "gc_license", expiresOn: "2020-01-01" },
    ];
    expect(lapsedCoiKinds(docs, "2026-09-24")).toEqual([other]);
  });

  it("tidies website links and drops anything that isn't a web address", () => {
    expect(websiteUrl("acme.com")).toBe("https://acme.com/");
    expect(websiteUrl("http://acme.com/x")).toBe("http://acme.com/x");
    expect(websiteUrl("  ")).toBeNull();
    expect(websiteUrl(null)).toBeNull();
    expect(websiteUrl("https://")).toBeNull();
  });
});

describe("units", () => {
  it("price per sf and selection states", () => {
    expect(pricePerSf(150_000_000, 1000)).toBe(150_000);
    expect(pricePerSf(null, 1000)).toBeNull();
    expect(pricePerSf(100, 0)).toBeNull();
    const today = "2026-09-24";
    expect(selectionState({ signedOffOn: "2026-09-01", signOffBy: "2026-08-01" }, today)).toBe("signed");
    expect(selectionState({ signedOffOn: null, signOffBy: null }, today)).toBe("pending");
    expect(selectionState({ signedOffOn: null, signOffBy: "2026-09-20" }, today)).toBe("overdue");
    expect(selectionState({ signedOffOn: null, signOffBy: "2026-09-30" }, today)).toBe("due_soon");
    expect(selectionState({ signedOffOn: null, signOffBy: "2026-10-30" }, today)).toBe("pending");
  });
});

describe("waterfall helpers", () => {
  it("describes tiers in plain words", () => {
    expect(
      describeTiers([
        { kind: "pref", rateBps: 800 },
        { kind: "pref", rateBps: 825 },
        { kind: "return_of_capital" },
        { kind: "split", lpBps: 8000, untilMultipleMilli: 2000 },
        { kind: "split", lpBps: 7250, untilMultipleMilli: null },
      ] as never),
    ).toEqual(["8% preferred return to investors", "8.25% preferred return to investors", "Return of investors' capital", "80% investors / 20% sponsor until investors reach 2.00x", "72.50% investors / 27.50% sponsor thereafter"]);
  });
  it("quarters", () => {
    expect(quarterBounds("2026-Q1")).toEqual({ from: "2026-01-01", to: "2026-03-31", label: "Q1 2026" });
    expect(quarterBounds("2024-Q4")).toEqual({ from: "2024-10-01", to: "2024-12-31", label: "Q4 2024" });
    expect(quarterBounds("2026-Q5")).toBeNull();
    expect(quarterOf("2026-09-24")).toBe("2026-Q3");
    expect(quarterOf("2026-01-02", -1)).toBe("2025-Q4");
  });
});

describe("forms", () => {
  it("signed amounts, cents back to text, percentages", () => {
    expect(optionalSignedMoney("", "a", "Amount")).toBeNull();
    expect(optionalSignedMoney("-5,000", "a", "Amount")).toBe(-500_000);
    expect(() => optionalSignedMoney("abc", "a", "Amount")).toThrow(/isn't a valid amount/);
    expect(centsToInput(null)).toBe("");
    expect(centsToInput(125_000_050)).toBe("1,250,000.50");
    expect(centsToInput(-500_000)).toBe("-5,000");
    expect(optionalPercentBps("", "p", "Rate")).toBeNull();
    expect(optionalPercentBps("7.5%", "p", "Rate")).toBe(750);
    expect(optionalPercentBps("10", "p", "Rate")).toBe(1000);
    expect(() => optionalPercentBps("101", "p", "Rate")).toThrow(/more than 100%/);
    expect(() => optionalPercentBps("ten", "p", "Rate")).toThrow(/percentage like/);
  });
});

describe("files", () => {
  it("previews, stored types, names and sizes", () => {
    expect(previewKind("image/jpeg; charset=x")).toBe("image");
    expect(previewKind("application/pdf")).toBe("pdf");
    expect(previewKind("text/html")).toBe("none");
    expect(normalizeContentType(null)).toBe("application/octet-stream");
    expect(normalizeContentType("Text/Plain; charset=utf-8")).toBe("text/plain");
    expect(normalizeContentType("not a type")).toBe("application/octet-stream");
    expect(storedContentType("text/html")).toBe("application/octet-stream");
    expect(storedContentType("application/pdf")).toBe("application/pdf");
    expect(cleanDisplayName("../../etc/pass\u0000wd")).toBe("passwd");
    expect(cleanDisplayName("   ")).toBe("Untitled");
    expect(fileExtension("Plan.PDF")).toBe("pdf");
    expect(fileExtension("README")).toBe("");
    expect(formatFileSize(512)).toMatch(/B/);
    expect(formatFileSize(5 * 1024 * 1024)).toMatch(/MB/);
  });
  it("canonical JSON for the audit chain", () => {
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson({ b: 1, a: [new Date("2026-01-01T00:00:00Z"), undefined], c: undefined })).toBe('{"a":["2026-01-01T00:00:00.000Z",null],"b":1}');
  });
});

describe("analytics edges", () => {
  it("handles no data", () => {
    expect(mean([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(phaseDurations([])).toEqual([]);
    const s = { templateKey: "t", title: "t", phaseKey: "p", unit: "business" as const, currentDays: 10, phaseStartedOn: "2026-02-01", completedOn: "2026-01-01" };
    expect(suggestDurations([s, s, s])).toEqual([]);
    // Close to the template: no suggestion.
    const near = { ...s, unit: "calendar" as const, completedOn: "2026-02-12" };
    expect(suggestDurations([near, near, near])).toEqual([]);
  });
});

describe("ICS", () => {
  it("adds location, description and link when present", () => {
    const t = buildCalendar({ name: "X", domain: "d", stamp: new Date("2026-01-01T00:00:00Z"), events: [{ uid: "a", date: "2026-02-01", title: "T", location: "L", description: "D", url: "https://x.test/p" }] });
    expect(t).toContain("LOCATION:L\r\n");
    expect(t).toContain("DESCRIPTION:D\r\n");
    expect(t).toContain("URL:https://x.test/p\r\n");
  });
});

describe("import parsers", () => {
  const one = (kind: Parameters<typeof validateRows>[0], mapping: Record<string, number>, row: string[]) => validateRows(kind, [row], mapping);

  it("projects: types, boroughs, BBLs, whole numbers and FAR", () => {
    const map = { name: 0, address: 1, type: 2, borough: 3, bbl: 4, lotAreaSqft: 5, residFar: 6, units: 7 };
    expect(one("projects", map, ["A", "1 St", "Gut renovation / townhouse conversion", "brooklyn", "3-01759-0013", "2,500 sf", "3.5", "4"]).valid[0]!.values).toMatchObject({ type: "gut_renovation", borough: "Brooklyn", bbl: "3017590013", lotAreaSqft: 2500, residFar: 3.5, units: 4 });
    const bad = one("projects", map, ["A", "1 St", "Castle", "Paris", "123", "1.5", "x", "99999"]).rejected[0]!.reasons.join(" | ");
    expect(bad).toMatch(/isn't a known project type/);
    expect(bad).toMatch(/isn't a known borough/);
    expect(bad).toMatch(/isn't a 10-digit BBL/);
    expect(bad).toMatch(/isn't a whole number/);
    expect(bad).toMatch(/isn't a number/);
    expect(bad).toMatch(/looks too large/);
    expect(one("projects", { name: 0, address: 1, type: 2, residFar: 3 }, ["A", "B", "Ground-up condo", "120"]).rejected[0]!.reasons[0]).toMatch(/looks too large/);
    expect(one("projects", { name: 0, address: 1, type: 2 }, ["x".repeat(200), "B", "Ground-up condo"]).rejected[0]!.reasons[0]).toMatch(/longer than 160 characters/);
  });

  it("budget amounts and unit numbers", () => {
    expect(one("budget", { category: 0, name: 1, originalCents: 2 }, ["Hard costs", "Framing", "-5"]).rejected[0]!.reasons[0]).toMatch(/can't be negative/);
    expect(one("budget", { category: 0, name: 1, originalCents: 2 }, ["Hard costs", "Framing", "lots"]).rejected[0]!.reasons[0]).toMatch(/isn't an amount/);
    const u = one("units", { unit: 0, beds: 1, baths: 2, exposure: 3, outdoorType: 4 }, ["1A", "2.3", "25", "north", "Moat"]).rejected[0]!.reasons.join(" | ");
    expect(u).toMatch(/whole or half numbers/);
    expect(u).toMatch(/isn't a known exposure/);
    expect(u).toMatch(/isn't a known outdoor space/);
    expect(one("units", { unit: 0, baths: 1 }, ["1A", "two"]).rejected[0]!.reasons[0]).toMatch(/isn't a number/);
    expect(one("units", { unit: 0, exposure: 1, outdoorType: 2, baths: 3 }, ["1A", "sw", "roof deck", "2.5"]).valid[0]!.values).toMatchObject({ exposure: "SW", outdoorType: "Roof deck", baths: 2.5 });
  });

  it("vendors and templates: email, rating, yes/no and duplicates", () => {
    const v = validateRows("vendors", [["Acme", "bad-email", "9"], ["Acme Co", "a@b.co", "5"], ["acme co", "", ""]], { name: 0, email: 1, rating: 2 });
    expect(v.rejected.find((r) => r.row === 2)!.reasons.join(" | ")).toMatch(/isn't an email address.*should be 1 to 5/);
    expect(v.rejected.find((r) => r.row === 4)!.reasons[0]).toBe("Same company as row 3");
    const t = validateRows("template", [["P", "A", "maybe", ""], ["P", "B", "no", "y"], ["Q", "B", "", ""]], { phase: 0, title: 1, milestone: 2, approval: 3 });
    expect(t.rejected[0]!.reasons[0]).toMatch(/should be yes or no/);
    expect(t.valid.map((x) => x.values)).toEqual([
      { phase: "P", title: "B", milestone: false, approval: true },
      { phase: "Q", title: "B" },
    ]);
  });

  it("template parts: repeated names get distinct keys", () => {
    const long = "Phase ".repeat(10);
    const { valid } = validateRows("template", [[`${long}one`, "Order title"], [`${long}two`, "Order title 2"], ["Build", "Order title"], ["Build", "!!!"]], { phase: 0, title: 1 });
    const parts = buildTemplateParts(valid);
    expect(parts.phases.map((p) => p.key)).toEqual(["phase_phase_phase_phase_phase_phase_phase_phase_ph", "phase_phase_phase_phase_phase_phase_phase_phase_ph_2", "build"]);
    expect(parts.tasks.map((t) => t.key)).toEqual(["order_title", "order_title_2", "order_title_2_2", "item"]);
    // A task can't follow itself.
    const self = validateRows("template", [["P", "A", "A"]], { phase: 0, title: 1, after: 2 });
    expect(buildTemplateParts(self.valid).unresolved).toHaveLength(1);
  });

  it("CSV and sheet edges", () => {
    expect(parseCsv("a,b")).toEqual([["a", "b"]]);
    expect(parseCsv("a\r\nb\rc")).toEqual([["a"], ["b"], ["c"]]);
    expect(parseCsv('x,"unterminated')).toEqual([["x", "unterminated"]]);
    expect(sheetFromGrid("s", [[], [" "], undefined])).toBeNull();
    expect(guessMapping("budget", ["Cost type", "Item", "Budget"])).toEqual({ category: 0, name: 1, originalCents: 2, notes: null });
    expect(zipUnpackedSize(new Uint8Array(10))).toBeNull();
    // A directory entry that isn't where the end record says.
    const eocd = new Uint8Array(22);
    const v = new DataView(eocd.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(10, 1, true);
    v.setUint32(16, 0, true);
    expect(zipUnpackedSize(eocd)).toBeNull();
    v.setUint16(10, 0xffff, true);
    expect(zipUnpackedSize(eocd)).toBe(Infinity);
  });
});

describe("inbound mail edges", () => {
  it("keys, addresses and headers", () => {
    expect(inboundKeyFor("", "", new Uint8Array([1, 2, 3, 4]))).toMatch(/^project-[a-z2-9]{4}$/);
    expect(emailAddressOf("a@b")).toBeNull();
    expect(inboundKeyFromRecipient("garbage", "in.x.com")).toBeNull();
    expect(inboundKeyFromRecipient("ab@in.x.com", "in.x.com")).toBeNull();
    expect(headerValues([{ name: "Authentication-Results", value: "a" }, { key: "authentication-results", value: "b" }, null, { name: "X", value: "c" }], "authentication-results")).toEqual(["a", "b"]);
    expect(headerValues({ "Authentication-Results": ["a", 1, "b"], Other: "x" }, "authentication-results")).toEqual(["a", "b"]);
    expect(headerValues("nope", "x")).toEqual([]);
    expect(senderAuthenticated("mx; dmarc=pass", "a@x.com")).toBe(true);
    expect(senderAuthenticated("mx; dkim=pass header.i=@x.com", "a@x.com")).toBe(true);
    expect(senderAuthenticated("mx; dkim=fail header.d=x.com", "a@x.com")).toBe(false);
  });

  it("signature edge cases", () => {
    const now = 1_790_000_000_000;
    const ts = Math.floor(now / 1000);
    const raw = Buffer.from("0123456789abcdef").toString("base64");
    const sig = signWebhook(raw, "m", ts, "b");
    expect(verifyWebhookSignature(raw, { id: "m", timestamp: String(ts), signature: sig }, "b", now)).toBe(true);
    expect(verifyWebhookSignature(raw, { id: "m", timestamp: "12abc", signature: sig }, "b", now)).toBe(false);
    expect(verifyWebhookSignature("whsec_", { id: "m", timestamp: String(ts), signature: sig }, "b", now)).toBe(false);
    expect(verifyWebhookSignature(raw, { id: "m", timestamp: String(ts), signature: "v2,abc v1" }, "b", now)).toBe(false);
  });

  it("payload shapes", () => {
    expect(parseInboundPayload(null, "d")).toBeNull();
    expect(parseInboundPayload({ type: "email.received", data: { from: "a@x.com" } }, "d")).toBeNull();
    const bare = parseInboundPayload({ id: "i1", from: { email: "a@x.com" }, to: "p@in.x.com, q@in.x.com", subject: "S", text: "T", attachments: [null, { name: "n.txt", contentType: "text/plain", content_base64: Buffer.from("hi").toString("base64") }, { filename: "e.bin", content: "" }], headers: { "authentication-results": "dmarc=pass" } }, "d")!;
    expect(bare).toMatchObject({ providerId: "i1", from: "a@x.com", to: ["p@in.x.com", " q@in.x.com"], hasBody: true, authResults: "dmarc=pass" });
    const withFromObj = parseInboundPayload({ type: "inbound.email", data: { message_id: "m1", from: { email: "a@x.com" }, to: ["p@in.x.com"] } }, "d")!;
    expect(withFromObj).toMatchObject({ providerId: "m1", from: "a@x.com", hasBody: false, authResults: null, subject: "", text: "" });
    const atts = parseInboundPayload({ from: "a@x.com", to: ["p@in.x.com"], attachments: [{ name: "n.txt", contentType: "text/plain", content_base64: Buffer.from("hi").toString("base64") }, { filename: "e.bin", content: "" }, "junk"] }, "d")!;
    expect(atts.providerId).toBe("d");
    expect(atts.attachments.map((a) => [a.filename, a.contentType, a.content?.length ?? null])).toEqual([
      ["n.txt", "text/plain", 2],
      ["e.bin", "application/octet-stream", null],
    ]);
    expect(htmlToText("<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;</p><div>f</div>\n\n\n\ng")).toBe(`a & b <c> "d" 'e'\nf\n\ng`);
  });
});
