/**
 * Field helpers (Modules D, F, G, K). Pure.
 */
import { dayOfWeek } from "./time";

/** WMO weather codes (Open-Meteo) → plain words. */
const WMO: [number[], string][] = [
  [[0], "Clear"],
  [[1, 2], "Partly cloudy"],
  [[3], "Overcast"],
  [[45, 48], "Fog"],
  [[51, 53, 55, 56, 57], "Drizzle"],
  [[61, 63, 65, 66, 67, 80, 81, 82], "Rain"],
  [[71, 73, 75, 77, 85, 86], "Snow"],
  [[95, 96, 99], "Thunderstorms"],
];

export function weatherSummary(code: number | null | undefined): string {
  if (code === null || code === undefined) return "Unknown";
  return WMO.find(([codes]) => codes.includes(code))?.[1] ?? "Unknown";
}

/** Open-Meteo daily response → the log's weather (Fahrenheit, inches, mph requested). */
export function parseOpenMeteo(body: unknown, date: string): { summary: string; highF: number | null; lowF: number | null; precipIn: number | null; windMph: number | null } | null {
  const daily = (body as { daily?: Record<string, unknown[]> })?.daily;
  if (!daily || !Array.isArray(daily.time)) return null;
  const i = daily.time.indexOf(date);
  if (i < 0) return null;
  const num = (k: string) => {
    const v = daily[k]?.[i];
    return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
  };
  return { summary: weatherSummary(num("weather_code")), highF: num("temperature_2m_max"), lowF: num("temperature_2m_min"), precipIn: num("precipitation_sum"), windMph: num("wind_speed_10m_max") };
}

/** Phases where the site is being worked on (a missing log gets a 5pm nudge on weekdays). */
export const ACTIVE_SITE_PHASES = new Set(["construction", "pre_construction", "tco_co"]);

export function isActiveSiteDay(phaseKey: string | null, date: string): boolean {
  if (!phaseKey || !ACTIVE_SITE_PHASES.has(phaseKey)) return false;
  const dow = dayOfWeek(date);
  return dow >= 1 && dow <= 5;
}

export function manpowerTotal(rows: readonly { count: number }[]): number {
  return rows.reduce((a, r) => a + (Number.isFinite(r.count) ? Math.max(0, Math.round(r.count)) : 0), 0);
}

/** Module G: open action items from the last meeting of the same type carry into the next. */
export function carryForward<T extends { kind: string; status: string }>(previous: readonly T[]): T[] {
  return previous.filter((i) => i.kind === "action" && i.status === "open");
}

export const MEETING_TYPES = [
  { key: "oac", label: "OAC" },
  { key: "design", label: "Design" },
  { key: "lender", label: "Lender" },
  { key: "partner", label: "Partner" },
  { key: "other", label: "Other" },
] as const;

export const DISCIPLINES = [
  { key: "A", label: "Architectural" },
  { key: "S", label: "Structural" },
  { key: "M", label: "Mechanical" },
  { key: "E", label: "Electrical" },
  { key: "P", label: "Plumbing" },
  { key: "FP", label: "Fire protection" },
] as const;

export const SUBMITTAL_DECISIONS = [
  { key: "approved", label: "Approved" },
  { key: "approved_as_noted", label: "Approved as noted" },
  { key: "revise_resubmit", label: "Revise and resubmit" },
  { key: "rejected", label: "Rejected" },
] as const;

export const PUNCH_STATUSES = [
  { key: "open", label: "Open" },
  { key: "ready", label: "Ready for review" },
  { key: "closed", label: "Closed" },
] as const;

/** Sheet number from a file name: "A-101 Floor Plans.pdf" → "A-101"; falls back to the name. */
export function sheetNumberFromName(name: string): string {
  const m = /^([A-Z]{1,3}-?\d{2,4}(?:\.\d+)?)/i.exec(name.trim());
  return (m ? m[1]! : name.replace(/\.pdf$/i, "")).toUpperCase().slice(0, 30);
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
