/**
 * Module A: BBL auto-fill from PLUTO (NYC Open Data 64uk-42ks). Pure.
 *
 * PLUTO serves numbers as decimal strings ("3.00000000000", "97000") and the
 * BBL as a number ("3017590013.00000000"). Only facts the lot really has are
 * returned; a blank or zero FAR stays unknown rather than becoming 0.
 */

export const PLUTO_DATASET = "64uk-42ks";

/** The columns auto-fill reads; the lookup asks for exactly these. */
export const PLUTO_COLUMNS = [
  "bbl",
  "address",
  "zonedist1",
  "zonedist2",
  "overlay1",
  "spdist1",
  "lotarea",
  "bldgarea",
  "lotfront",
  "lotdepth",
  "residfar",
  "builtfar",
  "yearbuilt",
  "numfloors",
  "unitsres",
  "landmark",
  "histdist",
  "version",
] as const;

export interface LotFacts {
  bbl: string;
  address: string | null;
  zoning: string | null;
  lotAreaSqft: number | null;
  lotFrontFt: number | null;
  lotDepthFt: number | null;
  residFar: number | null;
  builtFar: number | null;
  /** Residential FAR less built FAR, times the lot area: the floor area still buildable as of right. */
  unusedZsf: number | null;
  buildingSqft: number | null;
  yearBuilt: number | null;
  floors: number | null;
  residentialUnits: number | null;
  landmark: string | null;
  historicDistrict: string | null;
  /** PLUTO release, e.g. "26v2". */
  version: string | null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const positive = (v: unknown) => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** PLUTO's BBL ("3017590013.00000000") as our 10-digit string, or null. */
export function plutoBbl(v: unknown): string | null {
  const n = num(v);
  if (n === null) return null;
  const s = String(Math.trunc(n));
  return /^[1-5]\d{9}$/.test(s) ? s : null;
}

export function parsePluto(row: Record<string, unknown>): LotFacts | null {
  const bbl = plutoBbl(row.bbl);
  if (!bbl) return null;
  const districts = [str(row.zonedist1), str(row.zonedist2)].filter(Boolean).join(" / ");
  const extras = [str(row.overlay1), str(row.spdist1)].filter(Boolean);
  const zoning = districts ? (extras.length ? `${districts} (${extras.join(", ")})` : districts) : null;
  const lotArea = positive(row.lotarea);
  const residFar = positive(row.residfar);
  // Built FAR can be 0 on a vacant lot, which is a real fact.
  const builtFar = num(row.builtfar);
  const unused = lotArea !== null && residFar !== null && builtFar !== null ? Math.max(0, Math.round((residFar - builtFar) * lotArea)) : null;
  const year = positive(row.yearbuilt);
  return {
    bbl,
    address: str(row.address),
    zoning: zoning ? zoning.slice(0, 60) : null,
    lotAreaSqft: lotArea !== null ? Math.round(lotArea) : null,
    lotFrontFt: positive(row.lotfront) !== null ? round2(positive(row.lotfront)!) : null,
    lotDepthFt: positive(row.lotdepth) !== null ? round2(positive(row.lotdepth)!) : null,
    residFar: residFar !== null ? round2(residFar) : null,
    builtFar: builtFar !== null && builtFar >= 0 ? round2(builtFar) : null,
    unusedZsf: unused,
    buildingSqft: num(row.bldgarea) !== null ? Math.round(num(row.bldgarea)!) : null,
    yearBuilt: year !== null ? Math.round(year) : null,
    floors: positive(row.numfloors) !== null ? round2(positive(row.numfloors)!) : null,
    residentialUnits: num(row.unitsres) !== null ? Math.round(num(row.unitsres)!) : null,
    landmark: str(row.landmark),
    historicDistrict: str(row.histdist),
    version: str(row.version),
  };
}

/** The project fields auto-fill can set, from a lot's facts. */
export function projectFactsFromLot(l: LotFacts) {
  return { lotAreaSqft: l.lotAreaSqft, zoning: l.zoning, residFar: l.residFar, builtFar: l.builtFar, unusedZsf: l.unusedZsf, lotFrontFt: l.lotFrontFt, lotDepthFt: l.lotDepthFt };
}
