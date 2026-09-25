/**
 * The project tabs' code, loaded on demand (see project-view.tsx). The app
 * shell fetches all of it quietly once any page is idle, so the service
 * worker has it saved and every tab opens later with no signal.
 */
export const tabLoaders = {
  ActivityTab: () => import("./activity-tab"),
  ChecklistTab: () => import("./checklist-tab"),
  FilesTab: () => import("./files-tab"),
  RecordsTab: () => import("./records-tab"),
  FieldTab: () => import("./field/field-tab"),
  UnitsTab: () => import("./units-tab"),
  FinancialsTab: () => import("./financials-tab"),
  KeyDatesTab: () => import("./key-dates-tab"),
  TeamTab: () => import("./team-tab"),
};

export function warmProjectTabs(): void {
  for (const l of Object.values(tabLoaders)) void l().catch(() => undefined);
}
