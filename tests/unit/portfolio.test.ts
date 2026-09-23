import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { centsToInput, FieldError, optionalDecimal2, optionalInt, optionalMoney } from "@/core/forms";
import { fitLongEdge, safeFileName } from "@/core/images";
import {
  AUCTION_PHASES,
  currentPhase,
  daysInPhase,
  DEFAULT_PHASES,
  FLIP_PHASES,
  initialPhases,
  phaseKeyFor,
  phaseProgressBps,
  phasesForType,
  phaseSpans,
  setCurrentPhase,
  setPhaseSkipped,
  validatePhases,
} from "@/core/phases";
import { activeFilterCount, filterProjects, filtersFromParams, matchesFilters, type FilterableProject } from "@/core/portfolio";

const T = "2026-09-23";

describe("default phases per type (brief §5.2)", () => {
  it("standard types use the 11-phase track", () => {
    for (const t of ["ground_up_condo", "gut_renovation", "condo_conversion"] as const) expect(phasesForType(t)).toBe(DEFAULT_PHASES);
    expect(DEFAULT_PHASES.map((p) => p.name)).toEqual([
      "Pipeline",
      "Under Contract",
      "Due Diligence",
      "Closing",
      "Design & Zoning",
      "DOB Filing & Approval",
      "Pre-Construction",
      "Construction",
      "TCO / CO",
      "AG Plan & Sales",
      "Sold Out / Closed",
    ]);
  });
  it("contract flip has its own short track", () => {
    expect(phasesForType("contract_flip").map((p) => p.name)).toEqual(["Pipeline", "Under Contract", "Marketing to End Buyers", "Assignment", "Closed"]);
  });
  it("foreclosure auction puts Auction between Pipeline and Closing", () => {
    const names = phasesForType("foreclosure_auction").map((p) => p.name);
    expect(names.slice(0, 3)).toEqual(["Pipeline", "Auction", "Closing"]);
    expect(names).not.toContain("Under Contract");
    expect(names.at(-1)).toBe("Sold Out / Closed");
  });
  it("keys are unique within each track", () => {
    for (const list of [DEFAULT_PHASES, FLIP_PHASES, AUCTION_PHASES]) expect(new Set(list.map((p) => p.key)).size).toBe(list.length);
  });
  it("the migration backfill matches the code's phase lists", () => {
    const sql = readFileSync(path.resolve(__dirname, "../../drizzle/0003_portfolio.sql"), "utf8");
    const rows = [...sql.matchAll(/\('(std|flip|auction)','([a-z_]+)','([^']+)',(\d+)\)/g)].map((m) => ({ kind: m[1], key: m[2], name: m[3], ord: Number(m[4]) }));
    const check = (kind: string, list: readonly { key: string; name: string }[]) =>
      expect(rows.filter((r) => r.kind === kind).map((r) => [r.key, r.name, r.ord])).toEqual(list.map((p, i) => [p.key, p.name, i]));
    check("std", DEFAULT_PHASES);
    check("flip", FLIP_PHASES);
    check("auction", AUCTION_PHASES);
  });
});

describe("moving through phases", () => {
  const start = () => initialPhases(DEFAULT_PHASES, "2026-01-05");

  it("a new project starts in its first phase today", () => {
    const p = start();
    expect(currentPhase(p)?.key).toBe("pipeline");
    expect(p[0]).toMatchObject({ status: "active", startedOn: "2026-01-05" });
    expect(p.slice(1).every((x) => x.status === "pending" && x.startedOn === null)).toBe(true);
    expect(validatePhases(p)).toBeNull();
  });

  it("advancing completes earlier phases and starts the new one today", () => {
    const p = setCurrentPhase(start(), "under_contract", "2026-02-01");
    expect(p[0]).toMatchObject({ status: "done", startedOn: "2026-01-05", completedOn: "2026-02-01" });
    expect(p[1]).toMatchObject({ status: "active", startedOn: "2026-02-01", completedOn: null });
    expect(daysInPhase(p, "2026-02-11")).toBe(10);
  });

  it("jumping ahead marks skipped-over phases done today, but leaves skipped ones alone", () => {
    let p = setPhaseSkipped(start(), "due_diligence", true);
    p = setCurrentPhase(p, "design_zoning", "2026-03-01");
    expect(p.find((x) => x.key === "under_contract")).toMatchObject({ status: "done", startedOn: "2026-03-01", completedOn: "2026-03-01" });
    expect(p.find((x) => x.key === "due_diligence")).toMatchObject({ status: "skipped", startedOn: null });
    expect(currentPhase(p)?.key).toBe("design_zoning");
    expect(validatePhases(p)).toBeNull();
  });

  it("moving back reopens the phase and clears later dates", () => {
    let p = setCurrentPhase(start(), "closing", "2026-03-01");
    p = setCurrentPhase(p, "under_contract", "2026-03-10");
    expect(p.find((x) => x.key === "under_contract")).toMatchObject({ status: "active", startedOn: "2026-03-01", completedOn: null });
    expect(p.find((x) => x.key === "closing")).toMatchObject({ status: "pending", startedOn: null, completedOn: null });
  });

  it("choosing the current phase changes nothing", () => {
    const p = start();
    expect(setCurrentPhase(p, "pipeline", T)).toEqual(p);
  });

  it("refuses unknown and skipped phases", () => {
    expect(() => setCurrentPhase(start(), "nope", T)).toThrow(/Unknown/);
    const p = setPhaseSkipped(start(), "closing", true);
    expect(() => setCurrentPhase(p, "closing", T)).toThrow(/skipped/);
  });

  it("the current phase can't be skipped; restoring puts a phase back in the right state", () => {
    expect(() => setPhaseSkipped(start(), "pipeline", true)).toThrow(/another phase/);
    expect(() => setPhaseSkipped(start(), "nope", true)).toThrow(/Unknown/);
    let p = setPhaseSkipped(start(), "under_contract", true);
    p = setCurrentPhase(p, "closing", T);
    expect(setPhaseSkipped(p, "under_contract", false).find((x) => x.key === "under_contract")?.status).toBe("done");
    const later = setPhaseSkipped(p, "construction", true);
    expect(setPhaseSkipped(later, "construction", false).find((x) => x.key === "construction")?.status).toBe("pending");
    // Restoring a phase that isn't skipped is a no-op.
    expect(setPhaseSkipped(p, "closing", false)).toEqual([...p].sort((a, b) => a.sortOrder - b.sortOrder));
  });

  it("progress counts done phases, ignores skipped ones and credits task progress in the current phase", () => {
    let p = initialPhases(FLIP_PHASES, T); // 5 phases
    expect(phaseProgressBps(p)).toBe(0);
    p = setCurrentPhase(p, "marketing", T); // 2 done of 5
    expect(phaseProgressBps(p)).toBe(4000);
    expect(phaseProgressBps(p, 5000)).toBe(5000);
    expect(phaseProgressBps(p, 99_999)).toBe(6000);
    p = setPhaseSkipped(p, "assignment", true); // 2 done of 4
    expect(phaseProgressBps(p)).toBe(5000);
    const allDone = p.map((x) => ({ ...x, status: x.status === "skipped" ? x.status : ("done" as const) }));
    expect(phaseProgressBps(allDone)).toBe(10_000);
    expect(phaseProgressBps([])).toBe(0);
    expect(daysInPhase(allDone, T)).toBeNull();
  });

  it("timeline spans run from start to completion, the current phase to today", () => {
    const p = setCurrentPhase(initialPhases(FLIP_PHASES, "2026-01-01"), "under_contract", "2026-02-01");
    expect(phaseSpans(p, "2026-03-01")).toEqual([
      { key: "pipeline", name: "Pipeline", start: "2026-01-01", end: "2026-02-01", status: "done" },
      { key: "under_contract", name: "Under Contract", start: "2026-02-01", end: "2026-03-01", status: "active" },
    ]);
  });

  it("validates hand-edited phase lists", () => {
    const base = start();
    expect(validatePhases([])).toMatch(/at least one/);
    expect(validatePhases([{ ...base[0]!, name: " " }])).toMatch(/name/);
    expect(validatePhases([base[0]!, { ...base[1]!, key: "pipeline" }])).toMatch(/Duplicate/);
    expect(validatePhases(base.map((x) => ({ ...x, status: "active" as const })))).toMatch(/Only one/);
    expect(validatePhases(base.map((x) => ({ ...x, status: "pending" as const })))).toMatch(/must be current/);
    expect(validatePhases(base.map((x) => ({ ...x, status: "done" as const })))).toBeNull();
  });

  it("makes unique keys for custom phase names", () => {
    expect(phaseKeyFor("Rental / Hold", [])).toBe("rental_hold");
    expect(phaseKeyFor("Rental / Hold", ["rental_hold", "rental_hold_2"])).toBe("rental_hold_3");
    expect(phaseKeyFor("!!!", [])).toBe("phase");
  });
});

describe("portfolio filters", () => {
  const p = (over: Partial<FilterableProject> = {}): FilterableProject => ({
    name: "Sterling Place",
    address: "412 Sterling Pl",
    bbl: "3011370045",
    type: "gut_renovation",
    companyId: "c1",
    status: "active",
    currentPhaseKey: "closing",
    memberIds: ["u1", "u2"],
    ...over,
  });

  it("matches on every dimension", () => {
    expect(matchesFilters(p(), {})).toBe(true);
    expect(matchesFilters(p(), { phase: "closing", type: "gut_renovation", company: "c1", person: "u2", status: "active" })).toBe(true);
    expect(matchesFilters(p(), { phase: "pipeline" })).toBe(false);
    expect(matchesFilters(p(), { type: "contract_flip" })).toBe(false);
    expect(matchesFilters(p(), { company: "c2" })).toBe(false);
    expect(matchesFilters(p(), { person: "u9" })).toBe(false);
    expect(matchesFilters(p(), { status: "on_hold" })).toBe(false);
  });

  it("searches name, address and BBL digits", () => {
    expect(matchesFilters(p(), { q: "sterling" })).toBe(true);
    expect(matchesFilters(p(), { q: "412 STER" })).toBe(true);
    expect(matchesFilters(p(), { q: "3-01137" })).toBe(true);
    expect(matchesFilters(p(), { q: "45" })).toBe(false); // too short to be a BBL search
    expect(matchesFilters(p({ bbl: null }), { q: "301137" })).toBe(false);
    expect(filterProjects([p(), p({ name: "Other", address: "1 Main" })], { q: "main" })).toHaveLength(1);
  });

  it("reads filters from the URL and drops unknown statuses", () => {
    const params = new URLSearchParams("phase=closing&status=bogus&q=x&person=");
    const f = filtersFromParams((k) => params.get(k));
    expect(f).toEqual({ phase: "closing", type: null, company: null, person: null, status: null, q: "x" });
    expect(activeFilterCount(f)).toBe(2);
    expect(filtersFromParams((k) => (k === "status" ? "on_hold" : null)).status).toBe("on_hold");
  });
});

describe("form parsing", () => {
  it("whole numbers", () => {
    expect(optionalInt("", "a", "A")).toBeNull();
    expect(optionalInt(" 12,500 ", "a", "A")).toBe(12_500);
    expect(() => optionalInt("12.5", "a", "Lot")).toThrow(FieldError);
    expect(() => optionalInt("-3", "a", "Lot")).toThrow(/whole number/);
    expect(() => optionalInt("20000", "u", "Units", 10_000)).toThrow(/too large/);
    try {
      optionalInt("x", "lot", "Lot");
    } catch (e) {
      expect((e as FieldError).field).toBe("lot");
    }
  });
  it("two-decimal ratios", () => {
    expect(optionalDecimal2(null, "f", "FAR")).toBeNull();
    expect(optionalDecimal2("2.43", "f", "FAR")).toBe(2.43);
    expect(optionalDecimal2("6", "f", "FAR")).toBe(6);
    expect(() => optionalDecimal2("2.435", "f", "FAR")).toThrow(/two decimals/);
    expect(() => optionalDecimal2("120", "f", "FAR")).toThrow(/too large/);
  });
  it("money in cents, never negative here", () => {
    expect(optionalMoney("", "m", "Price")).toBeNull();
    expect(optionalMoney("$1,250,000", "m", "Price")).toBe(125_000_000);
    expect(optionalMoney("1250000.5", "m", "Price")).toBe(125_000_050);
    expect(() => optionalMoney("-5", "m", "Price")).toThrow(/negative/);
    expect(() => optionalMoney("abc", "m", "Price")).toThrow(/valid amount/);
    expect(() => optionalMoney("1.234", "m", "Price")).toThrow(FieldError);
  });
  it("cents back to input text", () => {
    expect(centsToInput(null)).toBe("");
    expect(centsToInput(125_000_000)).toBe("1,250,000");
    expect(centsToInput(125_000_050)).toBe("1,250,000.50");
    expect(centsToInput(5)).toBe("0.05");
  });
});

describe("images", () => {
  it("fits the long edge without upscaling", () => {
    expect(fitLongEdge(4032, 3024, 2560)).toEqual({ width: 2560, height: 1920 });
    expect(fitLongEdge(3024, 4032, 2560)).toEqual({ width: 1920, height: 2560 });
    expect(fitLongEdge(800, 600, 2560)).toEqual({ width: 800, height: 600 });
    expect(fitLongEdge(10000, 1, 960)).toEqual({ width: 960, height: 1 });
    expect(() => fitLongEdge(0, 10, 100)).toThrow();
  });
  it("makes safe file names", () => {
    expect(safeFileName("Survey (final) v2.pdf")).toBe("Survey-final-v2.pdf");
    expect(safeFileName("../../etc/passwd")).toBe("etcpasswd");
    expect(safeFileName("???")).toBe("file");
    expect(safeFileName("", "photo")).toBe("photo");
  });
});

