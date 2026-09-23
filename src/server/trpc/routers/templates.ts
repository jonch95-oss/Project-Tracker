import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { canProject, type Membership } from "@/core/permissions";
import { defaultTemplate } from "@/core/seed-library";
import { templateDefSchema } from "@/core/template-schema";
import { generateChecklist, scheduleDueDates, type TemplateDef } from "@/core/templates";
import { todayET } from "@/core/time";
import { schema } from "../../db";
import { recordAudit } from "../../services/audit";
import { applyTemplateUpdate, assertValidTemplate, effectiveToggles, ensureDefaultTemplates, loadTemplate, templateUpdatePreview } from "../../services/checklist";
import { globalProcedure, projectAccess, requireProject, router, type AuthedContext } from "../init";

const conflict = () =>
  new TRPCError({ code: "CONFLICT", message: "Someone else saved this template while you were editing. Reload to see their changes; yours weren't saved." });

const summary = (def: TemplateDef) => ({ phases: def.phases.length, tasks: def.tasks.length });

export const templatesRouter = router({
  /** Templates for the studio and the new-project picker. */
  list: globalProcedure("templates.edit")
    .input(z.object({ includeArchived: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      await ensureDefaultTemplates(ctx.db);
      const rows = await ctx.db
        .select()
        .from(schema.template)
        .where(input?.includeArchived ? undefined : isNull(schema.template.archivedAt))
        .orderBy(asc(schema.template.projectType), desc(schema.template.isDefault), asc(schema.template.name));
      const usage = await ctx.db
        .select({ templateId: schema.project.templateId, n: sql<number>`count(*)::int` })
        .from(schema.project)
        .where(isNull(schema.project.archivedAt))
        .groupBy(schema.project.templateId);
      return rows.map((r) => {
        const def = templateDefSchema.parse(r.definition);
        return {
          id: r.id,
          name: r.name,
          projectType: r.projectType,
          isDefault: r.isDefault,
          version: r.version,
          archivedAt: r.archivedAt,
          updatedAt: r.updatedAt,
          description: def.description ?? null,
          ...summary(def),
          projects: usage.find((u) => u.templateId === r.id)?.n ?? 0,
        };
      });
    }),

  get: globalProcedure("templates.edit")
    .input(z.object({ templateId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const t = await loadTemplate(ctx.db, input.templateId);
      if (!t) throw new TRPCError({ code: "NOT_FOUND" });
      return { id: t.row.id, name: t.row.name, projectType: t.row.projectType, isDefault: t.row.isDefault, version: t.row.version, archivedAt: t.row.archivedAt, definition: t.def };
    }),

  /** New template: a copy of another, or the library default for a type. */
  create: globalProcedure("templates.edit")
    .input(z.object({ name: z.string().trim().min(1).max(120), from: z.union([z.object({ templateId: z.uuid() }), z.object({ projectType: templateDefSchema.shape.projectType })]) }))
    .mutation(async ({ ctx, input }) => {
      let def: TemplateDef;
      if ("templateId" in input.from) {
        const src = await loadTemplate(ctx.db, input.from.templateId);
        if (!src) throw new TRPCError({ code: "NOT_FOUND" });
        def = { ...src.def, name: input.name };
      } else def = { ...defaultTemplate(input.from.projectType), name: input.name };
      return ctx.db.transaction(async (tx) => {
        const [row] = await tx.insert(schema.template).values({ name: input.name, projectType: def.projectType, definition: def, createdById: ctx.viewer.id }).returning({ id: schema.template.id });
        await tx.insert(schema.templateRevision).values({ templateId: row!.id, version: 1, definition: def, savedById: ctx.viewer.id });
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "create", entityType: "template", entityId: row!.id, summary: `${ctx.viewer.name} created the template ${input.name}`, ip: ctx.ip });
        return { id: row!.id };
      });
    }),

  /** Save the whole definition. Live projects are not touched (see applyUpdate). */
  save: globalProcedure("templates.edit")
    .input(z.object({ templateId: z.uuid(), version: z.number().int().min(1), definition: templateDefSchema }))
    .mutation(async ({ ctx, input }) => {
      const t = await loadTemplate(ctx.db, input.templateId);
      if (!t) throw new TRPCError({ code: "NOT_FOUND" });
      if (input.definition.projectType !== t.row.projectType) throw new TRPCError({ code: "BAD_REQUEST", message: "A template's project type can't change. Make a new template instead." });
      assertValidTemplate(input.definition);
      return ctx.db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.template)
          .set({ name: input.definition.name, definition: input.definition, version: sql`${schema.template.version} + 1`, updatedAt: new Date() })
          .where(and(eq(schema.template.id, input.templateId), eq(schema.template.version, input.version)))
          .returning({ version: schema.template.version });
        if (updated.length === 0) throw conflict();
        const version = updated[0]!.version;
        await tx.insert(schema.templateRevision).values({ templateId: input.templateId, version, definition: input.definition, savedById: ctx.viewer.id });
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "update",
          entityType: "template",
          entityId: input.templateId,
          summary: `${ctx.viewer.name} saved the template ${input.definition.name} (version ${version})`,
          data: summary(input.definition),
          ip: ctx.ip,
        });
        return { version };
      });
    }),

  /** Make a template the default for its project type. */
  setDefault: globalProcedure("templates.edit")
    .input(z.object({ templateId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const t = await loadTemplate(ctx.db, input.templateId);
      if (!t || t.row.archivedAt) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.db.transaction(async (tx) => {
        await tx.update(schema.template).set({ isDefault: false }).where(eq(schema.template.projectType, t.row.projectType));
        await tx.update(schema.template).set({ isDefault: true }).where(eq(schema.template.id, input.templateId));
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "update", entityType: "template", entityId: input.templateId, summary: `${ctx.viewer.name} made ${t.row.name} the default template`, ip: ctx.ip });
      });
      return { ok: true };
    }),

  setArchived: globalProcedure("templates.edit")
    .input(z.object({ templateId: z.uuid(), archived: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const t = await loadTemplate(ctx.db, input.templateId);
      if (!t) throw new TRPCError({ code: "NOT_FOUND" });
      if (input.archived && t.row.isDefault) throw new TRPCError({ code: "BAD_REQUEST", message: "Make another template the default for this type first." });
      await ctx.db.transaction(async (tx) => {
        await tx.update(schema.template).set({ archivedAt: input.archived ? new Date() : null }).where(eq(schema.template.id, input.templateId));
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "update", entityType: "template", entityId: input.templateId, summary: `${ctx.viewer.name} ${input.archived ? "archived" : "restored"} the template ${t.row.name}`, ip: ctx.ip });
      });
      return { ok: true };
    }),

  /** "Generate for a test project": the checklist these answers would produce, with due dates from a start date. */
  preview: globalProcedure("templates.edit")
    .input(z.object({ definition: templateDefSchema, toggles: z.array(z.string().max(60)).max(30).default([]), startOn: z.iso.date().optional() }))
    .query(({ input }) => {
      const def = input.definition;
      const gen = generateChecklist(def, effectiveToggles(def.projectType, input.toggles));
      const start = input.startOn ?? todayET();
      // Show dates as if each phase started right after the previous one's latest task.
      const starts = new Map<string, string>();
      let cursor = start;
      const dated = new Map<string, string>();
      for (const ph of gen.phases) {
        starts.set(ph.key, cursor);
        const due = scheduleDueDates(
          gen.tasks.filter((k) => k.phaseKey === ph.key || dated.has(k.key)).map((k) => ({ key: k.key, phaseKey: k.phaseKey, due: k.due, dueOn: dated.get(k.key) ?? null, dueManual: dated.has(k.key), completedOn: null })),
          starts,
        );
        for (const [k, d] of due) dated.set(k, d);
        const inPhase = gen.tasks.filter((k) => k.phaseKey === ph.key).map((k) => dated.get(k.key)).filter((d): d is string => !!d);
        if (inPhase.length) cursor = inPhase.reduce((a, b) => (a > b ? a : b));
      }
      return { phases: gen.phases, tasks: gen.tasks.map((k) => ({ ...k, dueOn: dated.get(k.key) ?? null })) };
    }),

  /** Projects using a template, and whether each is behind the latest version. */
  projects: globalProcedure("templates.edit")
    .input(z.object({ templateId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({ id: schema.project.id, name: schema.project.name, address: schema.project.address, templateVersion: schema.project.templateVersion })
        .from(schema.project)
        .where(and(eq(schema.project.templateId, input.templateId), isNull(schema.project.archivedAt)))
        .orderBy(asc(schema.project.name));
      // Only projects the viewer could edit the checklist of.
      const mine = await ctx.db.select().from(schema.projectMember).where(and(eq(schema.projectMember.userId, ctx.actor.userId), rows.length ? inArray(schema.projectMember.projectId, rows.map((r) => r.id)) : sql`false`));
      return rows.filter((r) => canProject(ctx.actor, (mine.find((m) => m.projectId === r.id) as Membership | undefined) ?? null, "checklist.edit"));
    }),

  /** Diff preview for applying the latest version to one project. */
  updatePreview: globalProcedure("templates.edit")
    .input(z.object({ projectId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      await requireChecklistEdit(ctx, input.projectId);
      const p = await templateUpdatePreview(ctx.db, input.projectId);
      if (!p) throw new TRPCError({ code: "BAD_REQUEST", message: "This project wasn't made from a template." });
      return {
        fromVersion: p.fromVersion,
        toVersion: p.toVersion,
        templateName: p.templateName,
        add: p.diff.add.map((k) => ({ key: k.key, title: k.title, phaseKey: k.phaseKey })),
        remove: p.diff.remove.map((t) => ({ id: t.id, title: t.title })),
        rename: p.diff.rename.map((r) => ({ id: r.task.id, from: r.task.title, to: r.to })),
        kept: p.diff.kept.map((t) => ({ id: t.id, title: t.title })),
      };
    }),

  /** Apply the latest version to the chosen projects. */
  applyUpdate: globalProcedure("templates.edit")
    .input(z.object({ projectIds: z.array(z.uuid()).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const results: { projectId: string; added: number; removed: number; renamed: number; kept: number }[] = [];
      for (const projectId of input.projectIds) {
        await requireChecklistEdit(ctx, projectId);
        const r = await ctx.db.transaction(async (tx) => {
          const out = await applyTemplateUpdate(tx, projectId, ctx.viewer.id);
          await recordAudit(tx, {
            actorId: ctx.viewer.id,
            actorName: ctx.viewer.name,
            action: "update",
            entityType: "checklist",
            entityId: projectId,
            projectId,
            summary: `${ctx.viewer.name} applied the latest template: ${out.added} added, ${out.removed} removed, ${out.renamed} renamed`,
            data: out,
            ip: ctx.ip,
          });
          return out;
        });
        results.push({ projectId, ...r });
      }
      return results;
    }),
});

async function requireChecklistEdit(ctx: AuthedContext, projectId: string) {
  requireProject(await projectAccess(ctx, projectId), "checklist.edit");
}
