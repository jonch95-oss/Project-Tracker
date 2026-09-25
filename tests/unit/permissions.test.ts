import { describe, expect, it } from "vitest";
import {
  canAssignGlobalRole,
  canGlobal,
  canGrantFlags,
  canRemoveMember,
  canProject,
  defaultFlags,
  GLOBAL_ROLES,
  type Actor,
  type GlobalAction,
  type GlobalRole,
  type Membership,
  type ProjectAction,
} from "@/core/permissions";

const actor = (role: GlobalRole, status: Actor["status"] = "active"): Actor => ({ userId: `u-${role}`, role, status });
const member = (flags: Partial<Membership> = {}): Membership => ({
  projectRole: "PM",
  canViewFinancials: false,
  canEditChecklist: false,
  canApprove: false,
  ...flags,
});

describe("global permissions", () => {
  const expected: Record<GlobalAction, GlobalRole[]> = {
    "users.manage": ["owner"],
    "company.settings": ["owner"],
    "templates.edit": ["owner", "admin"],
    "project.create": ["owner", "admin"],
    "audit.view": ["owner"],
    "system.view": ["owner"],
    "export.excel": ["owner"],
    "projects.viewAll": ["owner", "admin"],
    "directory.view": ["owner", "admin", "member"],
    "directory.edit": ["owner", "admin"],
    "analytics.view": ["owner"],
    "reports.view": ["owner"],
  };
  for (const [action, roles] of Object.entries(expected) as [GlobalAction, GlobalRole[]][]) {
    for (const role of GLOBAL_ROLES) {
      it(`${role} ${roles.includes(role) ? "can" : "cannot"} ${action}`, () => {
        expect(canGlobal(actor(role), action)).toBe(roles.includes(role));
      });
    }
  }
  it("nobody inactive or anonymous can do anything", () => {
    expect(canGlobal(actor("owner", "deactivated"), "users.manage")).toBe(false);
    expect(canGlobal(null, "project.create")).toBe(false);
    expect(canGlobal(undefined, "project.create")).toBe(false);
  });
});

describe("project permissions", () => {
  const actions: ProjectAction[] = [
    "project.view",
    "project.edit",
    "project.delete",
    "project.manageMembers",
    "financials.view",
    "financials.edit",
    "checklist.edit",
    "task.approve",
    "task.viewAll",
    "folder.viewAll",
    "photos.upload",
    "photos.manage",
    "activity.view",
  ];

  it("owner can do everything, even without membership", () => {
    for (const a of actions) expect(canProject(actor("owner"), null, a)).toBe(true);
  });

  it("admins run every project without being on it, except money (that follows the project's flag)", () => {
    for (const a of actions) expect(canProject(actor("admin"), null, a)).toBe(a !== "financials.view" && a !== "financials.edit" && a !== "project.delete");
  });

  it("members and outsiders need membership for anything", () => {
    for (const role of ["member", "external"] as const) {
      for (const a of actions) expect(canProject(actor(role), null, a)).toBe(false);
    }
  });

  it("deactivated users are denied everything", () => {
    for (const role of GLOBAL_ROLES) {
      for (const a of actions) {
        expect(canProject(actor(role, "deactivated"), member({ canViewFinancials: true, canApprove: true, canEditChecklist: true }), a)).toBe(false);
      }
    }
  });

  it("financials follow the flag for admin, member and external", () => {
    for (const role of ["admin", "member", "external"] as const) {
      expect(canProject(actor(role), member(), "financials.view")).toBe(false);
      expect(canProject(actor(role), member({ canViewFinancials: true }), "financials.view")).toBe(true);
    }
  });

  it("only admins with the flag edit financials", () => {
    expect(canProject(actor("admin"), member({ canViewFinancials: true }), "financials.edit")).toBe(true);
    expect(canProject(actor("admin"), member(), "financials.edit")).toBe(false);
    expect(canProject(actor("member"), member({ canViewFinancials: true }), "financials.edit")).toBe(false);
    expect(canProject(actor("external"), member({ canViewFinancials: true }), "financials.edit")).toBe(false);
  });

  it("admin manages assigned projects", () => {
    const m = member();
    expect(canProject(actor("admin"), m, "project.edit")).toBe(true);
    expect(canProject(actor("admin"), m, "project.manageMembers")).toBe(true);
    expect(canProject(actor("admin"), m, "checklist.edit")).toBe(true);
    expect(canProject(actor("admin"), m, "task.approve")).toBe(true);
    expect(canProject(actor("admin"), m, "project.delete")).toBe(false);
  });

  it("member checklist editing and approvals require flags", () => {
    expect(canProject(actor("member"), member(), "checklist.edit")).toBe(false);
    expect(canProject(actor("member"), member({ canEditChecklist: true }), "checklist.edit")).toBe(true);
    expect(canProject(actor("member"), member(), "task.approve")).toBe(false);
    expect(canProject(actor("member"), member({ canApprove: true }), "task.approve")).toBe(true);
    expect(canProject(actor("member"), member(), "project.edit")).toBe(false);
    expect(canProject(actor("member"), member(), "task.viewAll")).toBe(true);
  });

  it("externals see only their own tasks and shared folders, never edit checklists", () => {
    const m = member({ canEditChecklist: true, canApprove: true });
    expect(canProject(actor("external"), m, "project.view")).toBe(true);
    expect(canProject(actor("external"), m, "task.viewAll")).toBe(false);
    expect(canProject(actor("external"), m, "folder.viewAll")).toBe(false);
    expect(canProject(actor("external"), m, "checklist.edit")).toBe(false);
    expect(canProject(actor("external"), m, "task.approve")).toBe(true);
    expect(canProject(actor("external"), m, "project.manageMembers")).toBe(false);
  });

  it("photos: team members upload, admins manage, externals neither (until folders are shared)", () => {
    expect(canProject(actor("member"), member(), "photos.upload")).toBe(true);
    expect(canProject(actor("member"), member(), "photos.manage")).toBe(false);
    expect(canProject(actor("admin"), member(), "photos.manage")).toBe(true);
    expect(canProject(actor("external"), member({ canViewFinancials: true }), "photos.upload")).toBe(false);
    expect(canProject(actor("external"), member(), "photos.manage")).toBe(false);
  });

  it("activity feed is for the internal team", () => {
    expect(canProject(actor("member"), member(), "activity.view")).toBe(true);
    expect(canProject(actor("external"), member({ canViewFinancials: true }), "activity.view")).toBe(false);
  });
});

describe("granting", () => {
  const flags = { canViewFinancials: true, canEditChecklist: true, canApprove: true };
  it("owner grants anything", () => {
    expect(canGrantFlags(actor("owner"), null, flags)).toBe(true);
  });
  it("admin cannot grant financials they lack", () => {
    expect(canGrantFlags(actor("admin"), member(), flags)).toBe(false);
    expect(canGrantFlags(actor("admin"), member({ canViewFinancials: true }), flags)).toBe(true);
    expect(canGrantFlags(actor("admin"), member(), { ...flags, canViewFinancials: false })).toBe(true);
    // Not on the project: they can still add people, just not give money access.
    expect(canGrantFlags(actor("admin"), null, { ...flags, canViewFinancials: false })).toBe(true);
    expect(canGrantFlags(actor("admin"), null, flags)).toBe(false);
  });
  it("members, externals and deactivated users cannot grant", () => {
    expect(canGrantFlags(actor("member"), member({ canViewFinancials: true }), { ...flags, canViewFinancials: false })).toBe(false);
    expect(canGrantFlags(actor("external"), member(), { ...flags, canViewFinancials: false })).toBe(false);
    expect(canGrantFlags(actor("owner", "deactivated"), null, flags)).toBe(false);
  });
  it("owner cannot demote themselves; only owner assigns roles", () => {
    const o = actor("owner");
    expect(canAssignGlobalRole(o, "admin", o.userId)).toBe(false);
    expect(canAssignGlobalRole(o, "owner", o.userId)).toBe(true);
    expect(canAssignGlobalRole(o, "admin", "someone-else")).toBe(true);
    expect(canAssignGlobalRole(actor("admin"), "member", "x")).toBe(false);
  });
  it("default flags by role", () => {
    expect(defaultFlags("owner")).toEqual({ canViewFinancials: true, canEditChecklist: true, canApprove: true });
    expect(defaultFlags("admin").canViewFinancials).toBe(false);
    expect(defaultFlags("member")).toEqual({ canViewFinancials: false, canEditChecklist: false, canApprove: false });
    expect(defaultFlags("external")).toEqual({ canViewFinancials: false, canEditChecklist: false, canApprove: false });
  });
});

describe("admin limits on memberships", () => {
  const admin = actor("admin");
  const adminNoFin = member();
  const adminFin = member({ canViewFinancials: true });
  const noFlags = { canViewFinancials: false, canEditChecklist: false, canApprove: false };
  const withFin = { ...noFlags, canViewFinancials: true };

  it("an admin without financials may keep someone's financial access unchanged", () => {
    expect(canGrantFlags(admin, adminNoFin, { ...withFin, canApprove: true }, withFin, "member")).toBe(true);
  });
  it("…but may not revoke or grant it", () => {
    expect(canGrantFlags(admin, adminNoFin, noFlags, withFin, "member")).toBe(false);
    expect(canGrantFlags(admin, adminNoFin, withFin, noFlags, "member")).toBe(false);
    expect(canGrantFlags(admin, adminFin, noFlags, withFin, "member")).toBe(true);
  });
  it("admins never edit owners or other admins", () => {
    expect(canGrantFlags(admin, adminFin, noFlags, noFlags, "owner")).toBe(false);
    expect(canGrantFlags(admin, adminFin, noFlags, noFlags, "admin")).toBe(false);
    expect(canGrantFlags(actor("owner"), null, withFin, null, "admin")).toBe(true);
  });
  it("removal follows the same limits", () => {
    expect(canRemoveMember(admin, adminNoFin, { role: "member", canViewFinancials: false })).toBe(true);
    expect(canRemoveMember(admin, adminNoFin, { role: "member", canViewFinancials: true })).toBe(false);
    expect(canRemoveMember(admin, adminFin, { role: "external", canViewFinancials: true })).toBe(true);
    expect(canRemoveMember(admin, adminFin, { role: "owner", canViewFinancials: true })).toBe(false);
    expect(canRemoveMember(admin, adminFin, { role: "admin", canViewFinancials: false })).toBe(false);
    expect(canRemoveMember(actor("owner"), null, { role: "admin", canViewFinancials: true })).toBe(true);
    expect(canRemoveMember(actor("member"), adminFin, { role: "member", canViewFinancials: false })).toBe(false);
    expect(canRemoveMember(actor("admin", "deactivated"), adminFin, { role: "member", canViewFinancials: false })).toBe(false);
    // An admin not on the project can remove people too, except those with money access.
    expect(canRemoveMember(admin, null, { role: "member", canViewFinancials: false })).toBe(true);
    expect(canRemoveMember(admin, null, { role: "member", canViewFinancials: true })).toBe(false);
  });
});
