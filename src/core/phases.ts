/**
 * Project phases. Default phase lists per project type (brief §5.2) and the
 * pure rules for moving a project through them. Dates are New York calendar
 * dates ("YYYY-MM-DD"); nothing here reads the clock.
 */
import type { ProjectTypeKey } from "./labels";
import { daysBetween } from "./time";

export interface PhaseDef {
  key: string;
  name: string;
}

export const PHASE_STATUSES = ["pending", "active", "done", "skipped"] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export interface PhaseState {
  key: string;
  name: string;
  sortOrder: number;
  status: PhaseStatus;
  startedOn: string | null;
  completedOn: string | null;
}

const P = (key: string, name: string): PhaseDef => ({ key, name });

export const DEFAULT_PHASES: readonly PhaseDef[] = [
  P("pipeline", "Pipeline"),
  P("under_contract", "Under Contract"),
  P("due_diligence", "Due Diligence"),
  P("closing", "Closing"),
  P("design_zoning", "Design & Zoning"),
  P("dob_filing", "DOB Filing & Approval"),
  P("pre_construction", "Pre-Construction"),
  P("construction", "Construction"),
  P("tco_co", "TCO / CO"),
  P("ag_plan_sales", "AG Plan & Sales"),
  P("closed", "Sold Out / Closed"),
];

export const FLIP_PHASES: readonly PhaseDef[] = [
  P("pipeline", "Pipeline"),
  P("under_contract", "Under Contract"),
  P("marketing", "Marketing to End Buyers"),
  P("assignment", "Assignment"),
  P("closed", "Closed"),
];

/**
 * Foreclosure auction: "Auction" sits between Pipeline and Closing, and the
 * referee's terms of sale replace a negotiated contract, so Under Contract and
 * a pre-contract Due Diligence period drop out (title search and site checks
 * live in the Auction phase's checklist).
 */
export const AUCTION_PHASES: readonly PhaseDef[] = [
  P("pipeline", "Pipeline"),
  P("auction", "Auction"),
  ...DEFAULT_PHASES.slice(DEFAULT_PHASES.findIndex((p) => p.key === "closing")),
];

export function phasesForType(type: ProjectTypeKey): readonly PhaseDef[] {
  if (type === "contract_flip") return FLIP_PHASES;
  if (type === "foreclosure_auction") return AUCTION_PHASES;
  return DEFAULT_PHASES;
}

/** Initial phase rows for a new project: the first phase is active from `today`. */
export function initialPhases(defs: readonly PhaseDef[], today: string): PhaseState[] {
  return defs.map((d, i) => ({
    key: d.key,
    name: d.name,
    sortOrder: i,
    status: i === 0 ? "active" : "pending",
    startedOn: i === 0 ? today : null,
    completedOn: null,
  }));
}

function sorted(phases: readonly PhaseState[]): PhaseState[] {
  return [...phases].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function currentPhase(phases: readonly PhaseState[]): PhaseState | null {
  const list = sorted(phases);
  return list.find((p) => p.status === "active") ?? null;
}

/**
 * Make `key` the current phase. Earlier phases that were not skipped become
 * done (keeping their dates, filling gaps with `today`); later phases go back
 * to pending, except skipped ones which stay skipped. Moving backwards is
 * allowed (a deal can fall out of contract) and clears the later phases' dates.
 */
export function setCurrentPhase(phases: readonly PhaseState[], key: string, today: string): PhaseState[] {
  const list = sorted(phases);
  const idx = list.findIndex((p) => p.key === key);
  if (idx === -1) throw new Error(`Unknown phase: ${key}`);
  if (list[idx]!.status === "skipped") throw new Error("That phase is skipped. Restore it first.");
  const prevActive = list.find((p) => p.status === "active");
  if (prevActive?.key === key) return list;
  return list.map((p, i) => {
    if (i < idx) {
      if (p.status === "skipped") return p;
      return { ...p, status: "done", startedOn: p.startedOn ?? today, completedOn: p.completedOn ?? today };
    }
    if (i === idx) return { ...p, status: "active", startedOn: p.status === "done" ? p.startedOn ?? today : today, completedOn: null };
    if (p.status === "skipped") return p;
    return { ...p, status: "pending", startedOn: null, completedOn: null };
  });
}

/** Skip or restore a phase. The active phase can't be skipped; move on first. */
export function setPhaseSkipped(phases: readonly PhaseState[], key: string, skipped: boolean): PhaseState[] {
  const list = sorted(phases);
  const target = list.find((p) => p.key === key);
  if (!target) throw new Error(`Unknown phase: ${key}`);
  if (skipped && target.status === "active") throw new Error("Move the project to another phase before skipping this one.");
  if (!skipped && target.status !== "skipped") return list;
  const activeIdx = list.findIndex((p) => p.status === "active");
  const idx = list.indexOf(target);
  return list.map((p) => {
    if (p !== target) return p;
    if (skipped) return { ...p, status: "skipped", startedOn: null, completedOn: null };
    // Restoring a phase before the current one marks it done; after, pending.
    return { ...p, status: activeIdx !== -1 && idx < activeIdx ? "done" : "pending" };
  });
}

/** Whole days the project has been in its current phase (0 on the first day). */
export function daysInPhase(phases: readonly PhaseState[], today: string): number | null {
  const cur = currentPhase(phases);
  if (!cur?.startedOn) return null;
  return Math.max(0, daysBetween(cur.startedOn, today));
}

/**
 * Share of the phase track completed, in basis points (0–10000). Until tasks
 * exist this counts phases; once a phase has tasks, the caller passes the
 * current phase's task completion to credit partial progress inside it.
 */
export function phaseProgressBps(phases: readonly PhaseState[], currentPhaseTaskBps = 0): number {
  const counted = phases.filter((p) => p.status !== "skipped");
  if (counted.length === 0) return 0;
  const done = counted.filter((p) => p.status === "done").length;
  const hasActive = counted.some((p) => p.status === "active");
  const partial = hasActive ? Math.max(0, Math.min(10_000, currentPhaseTaskBps)) / 10_000 : 0;
  if (!hasActive && done === counted.length) return 10_000;
  return Math.round(((done + partial) / counted.length) * 10_000);
}

export interface PhaseSpan {
  key: string;
  name: string;
  start: string;
  end: string;
  status: PhaseStatus;
}

/** Spans for a timeline: done phases from start to completion, the active one to today. */
export function phaseSpans(phases: readonly PhaseState[], today: string): PhaseSpan[] {
  return sorted(phases)
    .filter((p) => (p.status === "done" || p.status === "active") && p.startedOn)
    .map((p) => ({
      key: p.key,
      name: p.name,
      start: p.startedOn!,
      end: p.status === "done" ? p.completedOn ?? p.startedOn! : today,
      status: p.status,
    }));
}

/** Validate a user-supplied phase list: unique keys, non-empty names, exactly one active. */
export function validatePhases(phases: readonly PhaseState[]): string | null {
  if (phases.length === 0) return "A project needs at least one phase.";
  const keys = new Set<string>();
  for (const p of phases) {
    if (!p.name.trim()) return "Every phase needs a name.";
    if (keys.has(p.key)) return `Duplicate phase: ${p.name}`;
    keys.add(p.key);
  }
  const active = phases.filter((p) => p.status === "active").length;
  const allDone = phases.every((p) => p.status === "done" || p.status === "skipped");
  if (active > 1) return "Only one phase can be current.";
  if (active === 0 && !allDone) return "One phase must be current.";
  return null;
}

/** A url-safe key for a new custom phase name, unique among `existing`. */
export function phaseKeyFor(name: string, existing: Iterable<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "phase";
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const k = `${base}_${n}`;
    if (!taken.has(k)) return k;
  }
}
