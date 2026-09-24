import "server-only";
import { parsePluto, PLUTO_COLUMNS, PLUTO_DATASET, type LotFacts } from "@/core/pluto";
import { recordsClient } from "./records";

export type LotLookup = (bbl: string) => Promise<LotFacts | null>;

/** PLUTO by BBL through the records client (app token, retries, a short deadline so the form never hangs). */
const socrataLookup: LotLookup = async (bbl) => {
  const rows = await recordsClient().rows(PLUTO_DATASET, { $select: PLUTO_COLUMNS.join(","), $where: `bbl=${bbl}`, $limit: 1, maxRows: 1 }, Date.now() + 8_000);
  return rows[0] ? parsePluto(rows[0]) : null;
};

/**
 * End-to-end tests run offline: PLUTO=stub answers every BBL with the same
 * made-up lot, so the auto-fill flow can be exercised without the city.
 */
const stubLookup: LotLookup = async (bbl) => ({
  bbl,
  address: "100 DEMO STREET",
  zoning: "R6B",
  lotAreaSqft: 2500,
  lotFrontFt: 25,
  lotDepthFt: 100,
  residFar: 2,
  builtFar: 0.8,
  unusedZsf: 3000,
  buildingSqft: 2000,
  yearBuilt: 1910,
  floors: 2,
  residentialUnits: 2,
  landmark: null,
  historicDistrict: null,
  version: "stub",
});

let override: LotLookup | null = null;
export function setLotLookupForTests(f: LotLookup | null) {
  override = f;
}

export type LotResult = { status: "found"; facts: LotFacts } | { status: "not_found" } | { status: "unavailable" };

/** Never throws: the form says what happened and carries on either way. */
export async function lookupLot(bbl: string): Promise<LotResult> {
  const f = override ?? (process.env.PLUTO === "stub" ? stubLookup : process.env.PLUTO === "off" ? async () => null : socrataLookup);
  try {
    const facts = await f(bbl);
    return facts ? { status: "found", facts } : { status: "not_found" };
  } catch {
    return { status: "unavailable" };
  }
}
