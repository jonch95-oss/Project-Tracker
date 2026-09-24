/**
 * Module M: portfolio analytics. Pure; the owner's view across every project.
 */
import { isBusinessDay } from "./calendar";
import { addDays, daysBetween } from "./time";

/** Middle value (the mean of the two middle values for an even count); null for no data. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function mean(xs: readonly number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Business days from `a` to `b` (0 on the same day; weekends and NY holidays don't count). */
export function businessDaysBetween(a: string, b: string): number {
  if (b <= a) return 0;
  let n = 0;
  for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) if (isBusinessDay(d)) n++;
  return n;
}

/** Cents per square foot, rounded to the cent; null without both. */
export function perSf(cents: number | null | undefined, sf: number | null | undefined): number | null {
  if (cents == null || !sf || sf <= 0) return null;
  return Math.round(cents / sf);
}

export interface PhaseSpan {
  type: string;
  phaseKey: string;
  phaseName: string;
  startedOn: string;
  completedOn: string;
}

/** Actual days in each phase, by project type: median and how many projects it's drawn from. */
export function phaseDurations(spans: readonly PhaseSpan[]): { type: string; phases: { key: string; name: string; medianDays: number; n: number }[] }[] {
  const byType = new Map<string, Map<string, { name: string; days: number[] }>>();
  for (const s of spans) {
    if (s.completedOn < s.startedOn) continue;
    const t = byType.get(s.type) ?? new Map();
    const p = t.get(s.phaseKey) ?? { name: s.phaseName, days: [] };
    p.days.push(daysBetween(s.startedOn, s.completedOn));
    t.set(s.phaseKey, p);
    byType.set(s.type, t);
  }
  return [...byType].map(([type, phases]) => ({ type, phases: [...phases].map(([key, p]) => ({ key, name: p.name, medianDays: median(p.days)!, n: p.days.length })) }));
}

export interface DurationSample {
  templateKey: string;
  title: string;
  phaseKey: string;
  unit: "business" | "calendar";
  /** The template's current days from phase start. */
  currentDays: number;
  phaseStartedOn: string;
  completedOn: string;
}

export interface DurationSuggestion {
  templateKey: string;
  title: string;
  phaseKey: string;
  unit: "business" | "calendar";
  currentDays: number;
  suggestedDays: number;
  samples: number;
}

/**
 * "Update template durations from actuals": for each template task done on
 * at least `minSamples` projects, the median days it actually took from its
 * phase's start. Suggested only where that differs from the template by at
 * least two days and a fifth.
 */
export function suggestDurations(samples: readonly DurationSample[], minSamples = 3): DurationSuggestion[] {
  const groups = new Map<string, { s: DurationSample; days: number[] }>();
  for (const s of samples) {
    if (s.completedOn < s.phaseStartedOn) continue;
    const days = s.unit === "business" ? businessDaysBetween(s.phaseStartedOn, s.completedOn) : daysBetween(s.phaseStartedOn, s.completedOn);
    const g = groups.get(s.templateKey) ?? { s, days: [] };
    g.days.push(days);
    groups.set(s.templateKey, g);
  }
  const out: DurationSuggestion[] = [];
  for (const [key, g] of groups) {
    if (g.days.length < minSamples) continue;
    const suggested = Math.max(0, Math.round(median(g.days)!));
    const diff = Math.abs(suggested - g.s.currentDays);
    if (diff < 2 || diff < g.s.currentDays * 0.2) continue;
    out.push({ templateKey: key, title: g.s.title, phaseKey: g.s.phaseKey, unit: g.s.unit, currentDays: g.s.currentDays, suggestedDays: suggested, samples: g.days.length });
  }
  return out.sort((a, b) => Math.abs(b.suggestedDays - b.currentDays) - Math.abs(a.suggestedDays - a.currentDays));
}
