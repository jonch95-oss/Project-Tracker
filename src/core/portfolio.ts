/**
 * Portfolio filtering (brief §7.1: filter by phase, type, company, person and
 * status). Pure, so the same rules drive the URL, the list and the tests.
 */
export const PROJECT_STATUSES = ["active", "on_hold", "closed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  active: "Active",
  on_hold: "On hold",
  closed: "Closed",
};

export interface PortfolioFilters {
  phase?: string | null;
  type?: string | null;
  company?: string | null;
  person?: string | null;
  status?: ProjectStatus | null;
  q?: string | null;
}

export interface FilterableProject {
  name: string;
  address: string;
  bbl: string | null;
  type: string;
  companyId: string;
  status: ProjectStatus;
  currentPhaseKey: string | null;
  memberIds: readonly string[];
}

export function matchesFilters(p: FilterableProject, f: PortfolioFilters): boolean {
  if (f.phase && p.currentPhaseKey !== f.phase) return false;
  if (f.type && p.type !== f.type) return false;
  if (f.company && p.companyId !== f.company) return false;
  if (f.person && !p.memberIds.includes(f.person)) return false;
  if (f.status && p.status !== f.status) return false;
  if (f.q) {
    const q = f.q.trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    const hay = `${p.name} ${p.address}`.toLowerCase();
    if (!hay.includes(q) && !(digits.length >= 3 && (p.bbl ?? "").includes(digits))) return false;
  }
  return true;
}

export function filterProjects<T extends FilterableProject>(list: readonly T[], f: PortfolioFilters): T[] {
  return list.filter((p) => matchesFilters(p, f));
}

/** Parse filters from URL search params, dropping unknown values. */
export function filtersFromParams(get: (k: string) => string | null): PortfolioFilters {
  const status = get("status");
  return {
    phase: get("phase") || null,
    type: get("type") || null,
    company: get("company") || null,
    person: get("person") || null,
    status: (PROJECT_STATUSES as readonly string[]).includes(status ?? "") ? (status as ProjectStatus) : null,
    q: get("q") || null,
  };
}

export function activeFilterCount(f: PortfolioFilters): number {
  return [f.phase, f.type, f.company, f.person, f.status, f.q].filter(Boolean).length;
}
