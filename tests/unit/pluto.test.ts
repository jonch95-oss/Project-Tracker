import { describe, expect, it } from "vitest";
import { parsePluto, plutoBbl, projectFactsFromLot } from "@/core/pluto";
import rows from "../fixtures/pluto-3017590013.json";

describe("PLUTO auto-fill (Module A)", () => {
  it("reads a live PLUTO row (543 Willoughby, release 26v2)", () => {
    const l = parsePluto(rows[0]!)!;
    expect(l).toMatchObject({
      bbl: "3017590013",
      address: "543 WILLOUGHBY AVENUE",
      zoning: "R6A",
      lotAreaSqft: 97000,
      lotFrontFt: 420,
      lotDepthFt: 200,
      residFar: 3,
      builtFar: 1.46,
      buildingSqft: 141246,
      yearBuilt: 1965,
      floors: 3,
      residentialUnits: 0,
      version: "26v2",
    });
    // (3.00 − 1.46) × 97,000
    expect(l.unusedZsf).toBe(149380);
    expect(projectFactsFromLot(l)).toEqual({ lotAreaSqft: 97000, zoning: "R6A", residFar: 3, builtFar: 1.46, unusedZsf: 149380, lotFrontFt: 420, lotDepthFt: 200 });
  });

  it("unknowns stay unknown; overbuilt lots have no unused ZSF; zoning carries overlays", () => {
    expect(parsePluto({ bbl: "garbage" })).toBeNull();
    expect(plutoBbl("3017590013.00000000")).toBe("3017590013");
    expect(plutoBbl(6017590013)).toBeNull();
    const vacant = parsePluto({ bbl: "3000010001", lotarea: "2000", residfar: "", builtfar: "0.00" })!;
    expect(vacant).toMatchObject({ residFar: null, builtFar: 0, unusedZsf: null, yearBuilt: null });
    expect(parsePluto({ bbl: "3000010001", lotarea: "2000", residfar: "2", builtfar: "3.1" })!.unusedZsf).toBe(0);
    expect(parsePluto({ bbl: "3000010001", zonedist1: "R7A", zonedist2: "C6-2", overlay1: "C2-4", spdist1: "DB" })!.zoning).toBe("R7A / C6-2 (C2-4, DB)");
  });
});
