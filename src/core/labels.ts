import type { GlobalRole } from "./permissions";

export const PROJECT_TYPE_LABEL = {
  ground_up_condo: "Ground-up condo",
  gut_renovation: "Gut renovation / townhouse conversion",
  contract_flip: "Contract flip",
  foreclosure_auction: "Foreclosure auction buy",
  condo_conversion: "Condo conversion",
} as const;

export type ProjectTypeKey = keyof typeof PROJECT_TYPE_LABEL;

export const PROJECT_TYPE_SHORT: Record<ProjectTypeKey, string> = {
  ground_up_condo: "Ground-up",
  gut_renovation: "Gut reno",
  contract_flip: "Flip",
  foreclosure_auction: "Auction",
  condo_conversion: "Conversion",
};

export const ROLE_LABEL: Record<GlobalRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Team member",
  external: "Outside collaborator",
};

export const ROLE_DESCRIPTION: Record<GlobalRole, string> = {
  owner: "Everything, including users, templates, company settings, audit log and system.",
  admin: "Everything on assigned projects. Can create projects and edit templates.",
  member: "Works tasks on assigned projects. Edits checklists only where granted.",
  external: "Architect, expediter, GC, lender or partner. Sees only what is assigned or shared.",
};

export const BOROUGHS = ["Brooklyn", "Manhattan", "Queens", "Bronx", "Staten Island"] as const;
