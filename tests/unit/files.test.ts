import { describe, expect, it } from "vitest";
import { canSeeFolder, cleanDisplayName, fileExtension, formatFileSize, normalizeContentType, previewKind } from "@/core/files";

describe("file rules", () => {
  it("previews images and PDFs only", () => {
    expect(previewKind("image/jpeg")).toBe("image");
    expect(previewKind("application/pdf; charset=binary")).toBe("pdf");
    expect(previewKind("image/svg+xml")).toBe("none"); // never rendered inline
    expect(previewKind("text/html")).toBe("none");
  });

  it("normalizes content types and names", () => {
    expect(normalizeContentType("Application/PDF")).toBe("application/pdf");
    expect(normalizeContentType("")).toBe("application/octet-stream");
    expect(normalizeContentType("not a type")).toBe("application/octet-stream");
    expect(cleanDisplayName("C:\\\\Users\\\\x\\\\Deed.pdf")).toBe("Deed.pdf");
    expect(cleanDisplayName("../../etc/passwd")).toBe("passwd");
    expect(cleanDisplayName("a\u0000b.pdf")).toBe("ab.pdf");
    expect(cleanDisplayName("   ")).toBe("Untitled");
    expect(fileExtension("plans.v2.PDF")).toBe("pdf");
    expect(fileExtension("README")).toBe("");
  });

  it("folder visibility: gated needs financials; outsiders need a share", () => {
    const gated = { gated: true };
    const plain = { gated: false };
    expect(canSeeFolder(plain, { seesAll: true, financials: false, shared: false })).toBe(true);
    expect(canSeeFolder(gated, { seesAll: true, financials: false, shared: false })).toBe(false);
    expect(canSeeFolder(gated, { seesAll: true, financials: true, shared: false })).toBe(true);
    expect(canSeeFolder(plain, { seesAll: false, financials: false, shared: false })).toBe(false);
    expect(canSeeFolder(plain, { seesAll: false, financials: false, shared: true })).toBe(true);
    expect(canSeeFolder(gated, { seesAll: false, financials: false, shared: true })).toBe(false);
  });

  it("formats sizes", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(5.5 * 1024 * 1024)).toBe("5.5 MB");
    expect(formatFileSize(3 * 1024 ** 3)).toBe("3.00 GB");
  });
});
