/**
 * Module C: the vendor and contact directory. Pure.
 */
import { EXPIRY_CATEGORIES, expiryState, isVendorCoi, type ExpiryState } from "./expiries";

export const VENDOR_KIND_LABEL: Record<string, string> = {
  contractor: "Contractor",
  consultant: "Consultant",
  supplier: "Supplier",
  lender: "Lender",
  broker: "Broker",
  legal: "Legal",
  other: "Other",
};

export const LICENSE_CATEGORIES = [
  { key: "gc_license", label: "GC license" },
  { key: "dob_registration", label: "DOB registration" },
  { key: "master_plumber", label: "Master plumber" },
  { key: "master_electrician", label: "Master electrician" },
  { key: "other_license", label: "Other license" },
] as const;

/** COIs use the expiry tracker's vendor COI kinds, so one lapsed certificate flags the vendor everywhere. */
export const COI_CATEGORIES = EXPIRY_CATEGORIES.filter((c) => isVendorCoi(c.key)).map((c) => ({ key: c.key, label: c.label.replace(/^Vendor COI: /, "COI: ") }));

export const DOC_CATEGORIES: Record<"license" | "coi" | "w9" | "other", readonly { key: string; label: string }[]> = {
  license: LICENSE_CATEGORIES,
  coi: COI_CATEGORIES,
  w9: [{ key: "w9", label: "W-9" }],
  other: [{ key: "other", label: "Other document" }],
};

export function docCategoryLabel(kind: string, category: string): string {
  const list = DOC_CATEGORIES[kind as keyof typeof DOC_CATEGORIES] ?? [];
  return list.find((c) => c.key === category)?.label ?? category;
}

export function isValidDocCategory(kind: string, category: string): boolean {
  return (DOC_CATEGORIES[kind as keyof typeof DOC_CATEGORIES] ?? []).some((c) => c.key === category);
}

export type DocState = ExpiryState | "none";

export function docState(expiresOn: string | null, today: string): DocState {
  return expiresOn ? expiryState(expiresOn, today) : "none";
}

/**
 * The directory's COI standing for a vendor, per kind: expired only when the
 * newest certificate of that kind has lapsed (a renewal on file clears it).
 */
export function lapsedCoiKinds(docs: readonly { kind: string; category: string; expiresOn: string | null }[], today: string): string[] {
  const latest = new Map<string, string>();
  for (const d of docs) {
    if (d.kind !== "coi" || !d.expiresOn) continue;
    const cur = latest.get(d.category);
    if (!cur || d.expiresOn > cur) latest.set(d.category, d.expiresOn);
  }
  return [...latest].filter(([, on]) => on < today).map(([k]) => k);
}

/** A tidy website link: "acme.com" → "https://acme.com"; anything else that isn't http(s) is dropped. */
export function websiteUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
