/**
 * Module L: the condo unit schedule and buyers' selections. Pure.
 */
import { roundDiv } from "./money";

export const SELECTION_CATEGORIES = ["Kitchen", "Bath", "Flooring", "Appliances", "Fixtures", "Millwork", "Paint", "Lighting", "Layout", "Other"] as const;
export type SelectionCategory = (typeof SELECTION_CATEGORIES)[number];

export const EXPOSURES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export const OUTDOOR_TYPES = ["Terrace", "Balcony", "Garden", "Roof deck", "Juliet"] as const;

/** Asking price per square foot, in cents, or null without both. */
export function pricePerSf(cents: number | null | undefined, sf: number | null | undefined): number | null {
  if (cents == null || !sf) return null;
  return roundDiv(cents, sf);
}

export type SelectionState = "signed" | "overdue" | "due_soon" | "pending";

/** Signed, or where the unsigned ones stand against their deadline (due soon = within 7 days). */
export function selectionState(s: { signedOffOn: string | null; signOffBy: string | null }, today: string): SelectionState {
  if (s.signedOffOn) return "signed";
  if (!s.signOffBy) return "pending";
  if (s.signOffBy < today) return "overdue";
  const soon = new Date(`${today}T12:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 7);
  return s.signOffBy <= soon.toISOString().slice(0, 10) ? "due_soon" : "pending";
}
