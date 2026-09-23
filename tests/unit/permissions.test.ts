import { describe, expect, it } from "vitest";
import {
  canAssignGlobalRole,
  canGlobal,
  canGrantFlags,
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
    "projects.viewAll": ["owner"],
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
  ];

  it("owner can do everything, even without membership", () => {
    for (const a of actions) expect(canProject(actor("owner"), null, a)).toBe(true);
  });

  it("everyone else needs membership for anything", () => {
    for (const role of ["admin", "member", "external"] as const) {
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
    expect(canGrantFlags(actor("admin"), null, { ...flags, canViewFinancials: false })).toBe(false);
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
