import { and, asc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { canGlobal, canProject, isInternalRole, type Membership } from "@/core/permissions";
import { canSeeFolder } from "@/core/files";
import { TASK_STATUS_LABEL } from "@/core/tasks";
import { schema } from "../../db";
import { protectedProcedure, router } from "../init";
import { visibleToOutsider } from "./projects";

export type SearchKind = "project" | "task" | "file" | "person" | "vendor";

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

const PER_KIND = 8;

/** `%text%` for ILIKE, with the wildcards in what was typed taken literally. */
function contains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * ⌘K (brief §7.7): projects, tasks, files, people and BBLs, permission-aware.
 * Every kind is limited to what the viewer can open: projects they can see,
 * tasks they can see on each (outside collaborators only their own or shared
 * ones), files in folders they can see (the Financial folder only with
 * financial access), and people only for the internal team. Nothing financial
 * is searched. Investors and lenders use their portal and get no results.
 */
export const searchRouter = router({
  query: protectedProcedure.input(z.object({ q: z.string().trim().min(1).max(100) })).query(async ({ ctx, input }): Promise<SearchHit[]> => {
    const actor = ctx.actor;
    if (actor.role === "investor") return [];
    const pattern = contains(input.q);
    const digits = input.q.replace(/\D/g, "");

    // Projects this person can open, and what they can do on each.
    const memberships = await ctx.db
      .select({
        projectId: schema.projectMember.projectId,
        projectRole: schema.projectMember.projectRole,
        canViewFinancials: schema.projectMember.canViewFinancials,
        canEditChecklist: schema.projectMember.canEditChecklist,
        canApprove: schema.projectMember.canApprove,
      })
      .from(schema.projectMember)
      .where(eq(schema.projectMember.userId, actor.userId));
    const mine = new Map<string, Membership>(memberships.map((m) => [m.projectId, m]));
    const projects = await ctx.db
      .select({ id: schema.project.id, name: schema.project.name, address: schema.project.address, bbl: schema.project.bbl, archivedAt: schema.project.archivedAt })
      .from(schema.project)
      .where(canGlobal(actor, "projects.viewAll") ? undefined : inArray(schema.project.id, [...mine.keys(), "00000000-0000-0000-0000-000000000000"]));
    const visible = projects.filter((p) => canProject(actor, mine.get(p.id) ?? null, "project.view"));
    if (visible.length === 0) return [];
    const nameOf = new Map(visible.map((p) => [p.id, p.name]));
    const can = (projectId: string, action: Parameters<typeof canProject>[2]) => canProject(actor, mine.get(projectId) ?? null, action);
    const ids = visible.map((p) => p.id);

    const hits: SearchHit[] = [];

    // Projects: name, address or BBL (typed with or without dashes).
    const needle = input.q.toLowerCase();
    const projectHits = visible
      .filter((p) => p.name.toLowerCase().includes(needle) || p.address.toLowerCase().includes(needle) || (digits.length >= 4 && (p.bbl ?? "").replace(/\D/g, "").includes(digits)))
      .sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || a.name.localeCompare(b.name))
      .slice(0, PER_KIND);
    for (const p of projectHits) {
      hits.push({ kind: "project", id: p.id, title: p.name, subtitle: [p.address, p.bbl ? `BBL ${p.bbl}` : null, p.archivedAt ? "Archived" : null].filter(Boolean).join(" · "), href: `/projects/${p.id}` });
    }

    // Tasks: every task on projects where they see all; elsewhere only their own or shared ones.
    const full = ids.filter((id) => can(id, "task.viewAll"));
    const limited = ids.filter((id) => !can(id, "task.viewAll"));
    const scopes: SQL[] = [];
    if (full.length) scopes.push(inArray(schema.task.projectId, full));
    if (limited.length) scopes.push(and(inArray(schema.task.projectId, limited), visibleToOutsider(actor.userId))!);
    if (scopes.length) {
      const tasks = await ctx.db
        .select({ id: schema.task.id, projectId: schema.task.projectId, title: schema.task.title, status: schema.task.status, dueOn: schema.task.dueOn })
        .from(schema.task)
        .where(and(or(...scopes), ilike(schema.task.title, pattern)))
        // Open work first, then by due date.
        .orderBy(sql`case when ${schema.task.status} = 'done' then 1 else 0 end`, asc(schema.task.dueOn), asc(schema.task.title))
        .limit(PER_KIND);
      for (const t of tasks) {
        hits.push({ kind: "task", id: t.id, title: t.title, subtitle: [nameOf.get(t.projectId), TASK_STATUS_LABEL[t.status], t.dueOn ? `due ${t.dueOn}` : null].filter(Boolean).join(" · "), href: `/projects/${t.projectId}?tab=checklist&task=${t.id}` });
      }
    }

    // Files: only in folders they can see (the Financial folder needs financial access).
    const shared = await ctx.db
      .select({ folderId: schema.folderShare.folderId, projectId: schema.folder.projectId, gated: schema.folder.gated })
      .from(schema.folderShare)
      .innerJoin(schema.folder, eq(schema.folder.id, schema.folderShare.folderId))
      .where(and(eq(schema.folderShare.userId, actor.userId), inArray(schema.folder.projectId, ids)));
    const allFolders = ids.filter((id) => can(id, "folder.viewAll") && can(id, "financials.view"));
    const openFolders = ids.filter((id) => can(id, "folder.viewAll") && !can(id, "financials.view"));
    const sharedFolders = shared.filter((f) => canSeeFolder({ gated: f.gated }, { seesAll: false, financials: can(f.projectId, "financials.view"), shared: true })).map((f) => f.folderId);
    const fileScopes: SQL[] = [];
    if (allFolders.length) fileScopes.push(inArray(schema.file.projectId, allFolders));
    if (openFolders.length) fileScopes.push(and(inArray(schema.file.projectId, openFolders), eq(schema.folder.gated, false))!);
    if (sharedFolders.length) fileScopes.push(inArray(schema.file.folderId, sharedFolders));
    if (fileScopes.length) {
      const files = await ctx.db
        .select({ id: schema.file.id, projectId: schema.file.projectId, folderId: schema.file.folderId, name: schema.file.name, folder: schema.folder.name })
        .from(schema.file)
        .innerJoin(schema.folder, eq(schema.folder.id, schema.file.folderId))
        .where(and(or(...fileScopes), isNull(schema.file.deletedAt), ilike(schema.file.name, pattern)))
        .orderBy(asc(schema.file.name))
        .limit(PER_KIND);
      for (const f of files) {
        hits.push({ kind: "file", id: f.id, title: f.name, subtitle: [nameOf.get(f.projectId), f.folder].filter(Boolean).join(" · "), href: `/projects/${f.projectId}?tab=files&folder=${f.folderId}&file=${f.id}` });
      }
    }

    // People: the internal team only (outside collaborators never see who else is on what). Investors are never listed.
    if (isInternalRole(actor.role)) {
      const seesEveryone = actor.role === "owner" || actor.role === "admin";
      const onMyProjects = seesEveryone
        ? null
        : sql`(${schema.user.role} in ('owner', 'admin', 'member') or exists (select 1 from ${schema.projectMember} where ${schema.projectMember.userId} = ${schema.user.id} and ${inArray(schema.projectMember.projectId, ids)}))`;
      const people = await ctx.db
        .select({ id: schema.user.id, name: schema.user.name, role: schema.user.role, title: schema.user.title })
        .from(schema.user)
        .where(and(eq(schema.user.status, "active"), ne(schema.user.role, "investor"), or(ilike(schema.user.name, pattern), ilike(schema.user.username, pattern)), onMyProjects ?? undefined))
        .orderBy(asc(schema.user.name))
        .limit(PER_KIND);
      const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Team member", external: "Outside collaborator" };
      for (const u of people) {
        hits.push({ kind: "person", id: u.id, title: u.name, subtitle: [u.title, ROLE[u.role]].filter(Boolean).join(" · "), href: `/portfolio?person=${u.id}` });
      }
    }

    // The vendor and contact directory, for the internal staff who can open it.
    if (canGlobal(actor, "directory.view")) {
      const vendors = await ctx.db
        .select({ id: schema.vendor.id, name: schema.vendor.name, trade: schema.vendor.trade, kind: schema.vendor.kind })
        .from(schema.vendor)
        .where(and(isNull(schema.vendor.archivedAt), or(ilike(schema.vendor.name, pattern), ilike(schema.vendor.trade, pattern), sql`exists (select 1 from ${schema.contact} where ${schema.contact.vendorId} = ${schema.vendor.id} and ${ilike(schema.contact.name, pattern)})`)))
        .orderBy(asc(schema.vendor.name))
        .limit(PER_KIND);
      for (const v of vendors) hits.push({ kind: "vendor", id: v.id, title: v.name, subtitle: v.trade ?? v.kind, href: `/directory/${v.id}` });
    }

    return hits;
  }),
});
