/**
 * Toggles: named site/deal conditions (brief §5.3). Turning one on inserts its
 * tasks (and sometimes a phase); turning it off removes its not-started tasks.
 */
import type { ProjectTypeKey } from "./labels";

export interface ToggleDef {
  key: string;
  label: string;
  /** The question asked when creating a project. */
  question: string;
  hint?: string;
}

export const TOGGLES = [
  { key: "landmarked", label: "Landmarked / historic district", question: "Is it landmarked or in a historic district (LPC)?" },
  { key: "mih", label: "MIH area", question: "Is it in a Mandatory Inclusionary Housing area?" },
  { key: "e_designation", label: "E-designation", question: "Does the lot carry an E-designation?" },
  { key: "occupied", label: "Occupied / rent-stabilized", question: "Is it occupied, or are there rent-stabilized tenants?" },
  { key: "demolition", label: "Demolition", question: "Will there be demolition?" },
  { key: "excavation", label: "Excavation / underpinning", question: "Excavation, underpinning or work near adjoining buildings?" },
  { key: "construction_loan", label: "Construction loan", question: "Will there be a construction loan?" },
  { key: "jv", label: "JV partner / outside equity", question: "Is there a JV partner or outside equity?" },
  { key: "tax_incentive", label: "Tax incentive (485-x / 421-a)", question: "Will you use a tax incentive (485-x / 421-a)?" },
  { key: "rental_hold", label: "Rental hold (not a condo sale)", question: "Hold as a rental instead of selling condos?", hint: "Off means a condo sale exit with an AG offering plan." },
  { key: "foreclosure", label: "Foreclosure auction purchase", question: "Is it a foreclosure auction purchase?" },
  { key: "contract_flip", label: "Contract flip (assignment)", question: "Is it a contract flip (assignment)?" },
  { key: "exchange_1031", label: "1031 exchange", question: "Is this part of a 1031 exchange?" },
  { key: "flood_zone", label: "Flood zone", question: "Is it in a FEMA flood zone?" },
  { key: "violations", label: "Existing violations", question: "Are there existing violations to clear?" },
] as const satisfies readonly ToggleDef[];

export type ToggleKey = (typeof TOGGLES)[number]["key"];
export const TOGGLE_KEYS = TOGGLES.map((t) => t.key) as ToggleKey[];

export function isToggleKey(k: string): k is ToggleKey {
  return (TOGGLE_KEYS as string[]).includes(k);
}

export function toggleLabel(k: string): string {
  return TOGGLES.find((t) => t.key === k)?.label ?? k;
}

/** Toggles a project type implies (and locks on). */
export function impliedToggles(type: ProjectTypeKey): ToggleKey[] {
  if (type === "foreclosure_auction") return ["foreclosure"];
  if (type === "contract_flip") return ["contract_flip"];
  return [];
}

/** Toggles that don't apply to a type (hidden from its questions). */
export function irrelevantToggles(type: ProjectTypeKey): ToggleKey[] {
  if (type === "contract_flip") return ["foreclosure", "demolition", "excavation", "construction_loan", "tax_incentive", "rental_hold", "contract_flip"];
  if (type === "foreclosure_auction") return ["foreclosure", "contract_flip"];
  return ["foreclosure", "contract_flip"];
}

/**
 * Conditions on a template phase or task: shown when any `showIf` toggle is on
 * (or `showIf` is empty), and hidden when any `hideIf` toggle is on.
 */
export interface Conditions {
  showIf?: string[];
  hideIf?: string[];
}

export function conditionsMet(c: Conditions, on: ReadonlySet<string>): boolean {
  if (c.hideIf?.some((k) => on.has(k))) return false;
  if (c.showIf && c.showIf.length > 0 && !c.showIf.some((k) => on.has(k))) return false;
  return true;
}

export function describeConditions(c: Conditions): string | null {
  const parts: string[] = [];
  if (c.showIf?.length) parts.push(`only if ${c.showIf.map(toggleLabel).join(" or ")}`);
  if (c.hideIf?.length) parts.push(`not if ${c.hideIf.map(toggleLabel).join(" or ")}`);
  return parts.length ? parts.join("; ") : null;
}
