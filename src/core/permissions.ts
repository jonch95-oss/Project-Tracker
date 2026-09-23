/**
 * Pure permission rules. The server middleware (src/server/trpc) resolves the
 * actor and membership from the database and asks these functions for a
 * decision; nothing here does I/O.
 */

export const GLOBAL_ROLES = ["owner", "admin", "member", "external"] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export const USER_STATUSES = ["active", "deactivated"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface Actor {
  userId: string;
  role: GlobalRole;
  status: UserStatus;
}

export interface MembershipFlags {
  canViewFinancials: boolean;
  canEditChecklist: boolean;
  canApprove: boolean;
}

export interface Membership extends MembershipFlags {
  projectRole: string;
}

/** Actions that are not tied to a single project. */
export type GlobalAction =
  | "users.manage" // invite, change role, deactivate
  | "company.settings"
  | "templates.edit"
  | "project.create"
  | "audit.view"
  | "system.view"
  | "export.excel"
  | "projects.viewAll";

/** Actions evaluated against one project and the actor's membership on it. */
export type ProjectAction =
  | "project.view"
  | "project.edit"
  | "project.delete"
  | "project.manageMembers"
  | "financials.view"
  | "financials.edit"
  | "checklist.edit"
  | "task.approve"
  | "task.viewAll" // see tasks not assigned or shared to me
  | "folder.viewAll"; // see folders not explicitly shared to me

const GLOBAL_RULES: Record<GlobalAction, readonly GlobalRole[]> = {
  "users.manage": ["owner"],
  "company.settings": ["owner"],
  "templates.edit": ["owner", "admin"],
  "project.create": ["owner", "admin"],
  "audit.view": ["owner"],
  "system.view": ["owner"],
  "export.excel": ["owner"],
  "projects.viewAll": ["owner"],
};

export function isActive(actor: Actor | null | undefined): actor is Actor {
  return !!actor && actor.status === "active";
}

export function canGlobal(actor: Actor | null | undefined, action: GlobalAction): boolean {
  if (!isActive(actor)) return false;
  return GLOBAL_RULES[action].includes(actor.role);
}

/**
 * Decide a project-scoped action.
 *
 * - Owner: everything on every project.
 * - Admin: everything on assigned projects, except financials, which follow
 *   the per-project `canViewFinancials` flag like everyone else.
 * - Member: assigned projects; checklist edits / approvals / financials only
 *   when the matching flag is set.
 * - External: assigned projects; only their own or shared tasks and folders;
 *   never edits the checklist; financials and approvals only when granted.
 */
export function canProject(
  actor: Actor | null | undefined,
  membership: Membership | null | undefined,
  action: ProjectAction,
): boolean {
  if (!isActive(actor)) return false;
  if (actor.role === "owner") return true;
  if (!membership) return false;

  switch (action) {
    case "project.view":
      return true;
    case "financials.view":
      return membership.canViewFinancials;
    case "financials.edit":
      return actor.role === "admin" && membership.canViewFinancials;
    case "project.edit":
    case "project.manageMembers":
      return actor.role === "admin";
    case "task.viewAll":
    case "folder.viewAll":
      return actor.role !== "external";
    case "project.delete":
      return false;
    case "checklist.edit":
      if (actor.role === "admin") return true;
      if (actor.role === "member") return membership.canEditChecklist;
      return false;
    case "task.approve":
      if (actor.role === "admin") return true;
      return membership.canApprove;
  }
}

/**
 * May the actor set a membership to `requested`, given what it was before
 * (`before`, null for a new member) and the target's global role?
 *
 * - Owners may do anything.
 * - Admins manage only members and outside collaborators on projects they
 *   are on — never owners or other admins (including themselves).
 * - An admin may leave financial visibility as it was, but may only grant
 *   or revoke it if they can see financials themselves.
 */
export function canGrantFlags(
  actor: Actor,
  actorMembership: Membership | null,
  requested: MembershipFlags,
  before: MembershipFlags | null = null,
  targetRole: GlobalRole = "member",
): boolean {
  if (!isActive(actor)) return false;
  if (actor.role === "owner") return true;
  if (actor.role !== "admin" || !actorMembership) return false;
  if (targetRole === "owner" || targetRole === "admin") return false;
  const financialsChanged = requested.canViewFinancials !== (before?.canViewFinancials ?? false);
  if (financialsChanged && !actorMembership.canViewFinancials) return false;
  return true;
}

/** Removing someone from a project follows the same limits as editing them. */
export function canRemoveMember(actor: Actor, actorMembership: Membership | null, target: { role: GlobalRole; canViewFinancials: boolean }): boolean {
  if (!isActive(actor)) return false;
  if (actor.role === "owner") return true;
  if (actor.role !== "admin" || !actorMembership) return false;
  if (target.role === "owner" || target.role === "admin") return false;
  return !target.canViewFinancials || actorMembership.canViewFinancials;
}

export function canAssignGlobalRole(actor: Actor, target: GlobalRole, targetUserId: string): boolean {
  if (!canGlobal(actor, "users.manage")) return false;
  // The owner cannot demote themselves: there must always be an owner.
  if (targetUserId === actor.userId && target !== "owner") return false;
  return true;
}

/** Default flags for a new membership, by global role. */
export function defaultFlags(role: GlobalRole): MembershipFlags {
  switch (role) {
    case "owner":
      return { canViewFinancials: true, canEditChecklist: true, canApprove: true };
    case "admin":
      return { canViewFinancials: false, canEditChecklist: true, canApprove: true };
    case "member":
      return { canViewFinancials: false, canEditChecklist: false, canApprove: false };
    case "external":
      return { canViewFinancials: false, canEditChecklist: false, canApprove: false };
  }
}

export const PROJECT_ROLES = [
  "PM",
  "Acquisitions",
  "Construction",
  "Legal",
  "Sales",
  "Finance",
  "Architect",
  "Expediter",
  "GC",
  "Lender",
  "JV Partner",
  "Consultant",
] as const;
