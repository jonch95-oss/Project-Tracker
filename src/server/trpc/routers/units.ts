import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { SELECTION_CATEGORIES, selectionState, pricePerSf } from "@/core/units";
import { todayET } from "@/core/time";
import { schema, type DbOrTx } from "../../db";
import { recordAudit } from "../../services/audit";
import { notify, taskHref } from "../../services/tasks";
import { planDate } from "../dates";
import { projectProcedure, router, type AuthedContext, type ProjectAccess } from "../init";
import { assertOnProject } from "./docs";

type Ctx = AuthedContext & { project: ProjectAccess };
const text = (max: number) => z.string().trim().max(max);
const conflict = () => new TRPCError({ code: "CONFLICT", message: "Someone else just changed this. Reload to see the latest." });
const priceCents = z.number().int().min(0).max(1_000_000_000_000);

function team(access: ProjectAccess) {
  if (!access.can("task.viewAll")) throw new TRPCError({ code: "FORBIDDEN", message: "This is for the project team." });
}

async function audit(tx: DbOrTx, c: Ctx, entityId: string, summary: string, action: "create" | "update" | "delete" = "update", financial = false) {
  await recordAudit(tx, { actorId: c.viewer.id, actorName: c.viewer.name, action, entityType: financial ? "sale" : "unit", entityId, projectId: c.project.projectId, summary, ip: c.ip });
}

/** Selection tasks live in Construction when the project has it, else in the current phase. */
async function selectionPhase(tx: DbOrTx, projectId: string): Promise<string> {
  const phases = await tx.select().from(schema.projectPhase).where(eq(schema.projectPhase.projectId, projectId)).orderBy(asc(schema.projectPhase.sortOrder));
  const construction = phases.find((p) => p.key === "construction" && p.status !== "skipped");
  return (construction ?? phases.find((p) => p.status === "active") ?? phases[0]!).key;
}

const taskTitle = (unit: string, category: string, choice: string) => `Unit ${unit} · ${category}: ${choice}`.slice(0, 200);

/** Keep the GC's task in step with the selection: waiting on the buyer until signed, then live work. */
async function syncSelectionTask(tx: DbOrTx, c: Ctx, sel: typeof schema.unitSelection.$inferSelect, unit: string, assigneeId: string | null | undefined) {
  const signed = !!sel.signedOffOn;
  const title = taskTitle(unit, sel.category, sel.choice);
  const description = `Buyer selection for unit ${unit}.${sel.signOffBy ? ` Sign-off due ${sel.signOffBy}.` : ""}${sel.notes ? `\n\n${sel.notes}` : ""}`;
  const state = signed ? { status: "not_started" as const, waitingOn: null, waitingSince: null } : { status: "waiting" as const, waitingOn: "Buyer sign-off", waitingSince: todayET() };
  if (sel.taskId) {
    const [t] = await tx.select().from(schema.task).where(eq(schema.task.id, sel.taskId));
    if (t) {
      // Work already under way keeps its status; only the waiting/ready switch follows the sign-off.
      const follow = t.status === "waiting" || (t.status === "not_started" && !signed);
      await tx
        .update(schema.task)
        .set({ title, description, dueOn: sel.signOffBy, dueManual: !!sel.signOffBy, ...(assigneeId !== undefined ? { assigneeId } : {}), ...(follow ? state : {}), version: sql`${schema.task.version} + 1`, updatedAt: new Date() })
        .where(eq(schema.task.id, t.id));
      return t.id;
    }
  }
  const phaseKey = await selectionPhase(tx, c.project.projectId);
  const [max] = await tx.select({ m: sql<number>`coalesce(max(${schema.task.sortOrder}), -1)::int` }).from(schema.task).where(and(eq(schema.task.projectId, c.project.projectId), eq(schema.task.phaseKey, phaseKey)));
  const [t] = await tx
    .insert(schema.task)
    .values({ projectId: c.project.projectId, phaseKey, title, role: "Construction", description, assigneeId: assigneeId ?? null, dueOn: sel.signOffBy, dueManual: !!sel.signOffBy, ...state, sortOrder: (max?.m ?? -1) + 1, createdById: c.viewer.id })
    .returning({ id: schema.task.id });
  await tx.update(schema.unitSelection).set({ taskId: t!.id }).where(eq(schema.unitSelection.id, sel.id));
  if (assigneeId && assigneeId !== c.viewer.id) {
    await notify(tx, c.viewer.id, [{ userId: assigneeId, kind: "assigned", title: `Assigned: “${title}”`, body: signed ? "Signed off by the buyer." : "Waiting on the buyer's sign-off.", projectId: c.project.projectId, taskId: t!.id, href: taskHref(c.project.projectId, t!.id) }]);
  }
  return t!.id;
}

const unitFields = z.object({
  unit: text(40).min(1),
  floor: text(20).nullish(),
  sf: z.number().int().min(1).max(1_000_000).nullish(),
  beds: z.number().min(0).max(20).multipleOf(0.5).nullish(),
  baths: z.number().min(0).max(20).multipleOf(0.5).nullish(),
  exposure: text(40).nullish(),
  outdoorSf: z.number().int().min(0).max(100_000).nullish(),
  outdoorType: text(40).nullish(),
  /** Only people who can edit financials may set it; sent by others it's refused. */
  askCents: priceCents.nullish(),
});

const selectionFields = z.object({
  unitId: z.uuid(),
  category: z.enum(SELECTION_CATEGORIES),
  choice: text(200).min(1),
  upgradeCents: priceCents.nullish(),
  signOffBy: planDate.nullish(),
  notes: text(2000).nullish(),
  assigneeId: z.string().max(64).nullish(),
});

export const unitsRouter = router({
  /** Module L: the unit schedule and each unit's selections. Prices only with financial access. */
  list: projectProcedure().query(async ({ ctx, input }) => {
    const c = ctx as Ctx;
    team(c.project);
    const fin = c.project.can("financials.view");
    const today = todayET();
    const units = await ctx.db.select().from(schema.saleUnit).where(eq(schema.saleUnit.projectId, input.projectId)).orderBy(asc(schema.saleUnit.sortOrder), asc(schema.saleUnit.unit));
    const sels = await ctx.db
      .select({ s: schema.unitSelection, taskStatus: schema.task.status, assigneeId: schema.task.assigneeId, assigneeName: schema.user.name })
      .from(schema.unitSelection)
      .leftJoin(schema.task, eq(schema.task.id, schema.unitSelection.taskId))
      .leftJoin(schema.user, eq(schema.user.id, schema.task.assigneeId))
      .where(eq(schema.unitSelection.projectId, input.projectId))
      .orderBy(asc(schema.unitSelection.signOffBy), asc(schema.unitSelection.createdAt));
    const selections = sels.map((r) => ({
      id: r.s.id,
      unitId: r.s.unitId,
      category: r.s.category,
      choice: r.s.choice,
      upgradeCents: fin ? r.s.upgradeCents : null,
      isUpgrade: r.s.upgradeCents !== null && r.s.upgradeCents > 0,
      signOffBy: r.s.signOffBy,
      signedOffOn: r.s.signedOffOn,
      signedOffName: r.s.signedOffName,
      notes: r.s.notes,
      taskId: r.s.taskId,
      taskStatus: r.taskStatus,
      assigneeId: r.assigneeId,
      assigneeName: r.assigneeName,
      state: selectionState(r.s, today),
      version: r.s.version,
    }));
    return {
      units: units.map((u) => ({
        id: u.id,
        unit: u.unit,
        floor: u.floor,
        sf: u.sf,
        beds: u.beds,
        baths: u.baths,
        exposure: u.exposure,
        outdoorSf: u.outdoorSf,
        outdoorType: u.outdoorType,
        status: u.status,
        askCents: fin ? u.askCents : null,
        askPsfCents: fin ? pricePerSf(u.askCents, u.sf) : null,
        version: u.version,
        selections: selections.filter((s) => s.unitId === u.id),
      })),
      summary: {
        units: units.length,
        sf: units.reduce((a, u) => a + (u.sf ?? 0), 0),
        pendingSignOff: selections.filter((s) => s.state !== "signed").length,
        overdue: selections.filter((s) => s.state === "overdue").length,
      },
      access: { canEdit: c.project.can("checklist.edit"), canSeePrices: fin, canEditPrices: c.project.can("financials.edit") },
    };
  }),

  saveUnit: projectProcedure("checklist.edit")
    .input(unitFields.extend({ id: z.uuid().optional(), version: z.number().int().min(1).optional() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      const priced = input.askCents !== undefined;
      if (priced && !c.project.can("financials.edit")) throw new TRPCError({ code: "FORBIDDEN", message: "Asking prices are for people who edit the financials." });
      return ctx.db.transaction(async (tx) => {
        const clash = await tx
          .select({ id: schema.saleUnit.id })
          .from(schema.saleUnit)
          .where(and(eq(schema.saleUnit.projectId, input.projectId), sql`lower(${schema.saleUnit.unit}) = lower(${input.unit})`, input.id ? sql`${schema.saleUnit.id} <> ${input.id}` : undefined));
        if (clash.length) throw new TRPCError({ code: "CONFLICT", message: `There's already a unit ${input.unit}.` });
        const values = {
          unit: input.unit,
          floor: input.floor || null,
          sf: input.sf ?? null,
          beds: input.beds ?? null,
          baths: input.baths ?? null,
          exposure: input.exposure || null,
          outdoorSf: input.outdoorSf ?? null,
          outdoorType: input.outdoorType || null,
          ...(priced ? { askCents: input.askCents ?? null } : {}),
        };
        if (input.id) {
          const r = await tx
            .update(schema.saleUnit)
            .set({ ...values, version: sql`${schema.saleUnit.version} + 1`, updatedAt: new Date() })
            .where(and(eq(schema.saleUnit.id, input.id), eq(schema.saleUnit.projectId, input.projectId), eq(schema.saleUnit.version, input.version ?? 0)))
            .returning({ id: schema.saleUnit.id });
          if (!r.length) throw conflict();
          await audit(tx, c, input.id, `${c.viewer.name} updated unit ${input.unit}`, "update", priced);
          return { id: input.id };
        }
        const [max] = await tx.select({ m: sql<number>`coalesce(max(${schema.saleUnit.sortOrder}), -1)::int` }).from(schema.saleUnit).where(eq(schema.saleUnit.projectId, input.projectId));
        const [row] = await tx.insert(schema.saleUnit).values({ ...values, projectId: input.projectId, sortOrder: (max?.m ?? -1) + 1 }).returning({ id: schema.saleUnit.id });
        await audit(tx, c, row!.id, `${c.viewer.name} added unit ${input.unit}`, "create", priced);
        return { id: row!.id };
      });
    }),

  saveSelection: projectProcedure("checklist.edit")
    .input(selectionFields.extend({ id: z.uuid().optional(), version: z.number().int().min(1).optional() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      const priced = input.upgradeCents !== undefined;
      if (priced && !c.project.can("financials.edit")) throw new TRPCError({ code: "FORBIDDEN", message: "Upgrade prices are for people who edit the financials." });
      return ctx.db.transaction(async (tx) => {
        const [u] = await tx.select().from(schema.saleUnit).where(and(eq(schema.saleUnit.id, input.unitId), eq(schema.saleUnit.projectId, input.projectId)));
        if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "Unit not found" });
        if (input.assigneeId) await assertOnProject(tx, input.projectId, input.assigneeId);
        const values = { unitId: u.id, category: input.category, choice: input.choice, signOffBy: input.signOffBy ?? null, notes: input.notes || null, ...(priced ? { upgradeCents: input.upgradeCents ?? null } : {}) };
        let sel: typeof schema.unitSelection.$inferSelect;
        if (input.id) {
          const [row] = await tx
            .update(schema.unitSelection)
            .set({ ...values, version: sql`${schema.unitSelection.version} + 1`, updatedAt: new Date() })
            .where(and(eq(schema.unitSelection.id, input.id), eq(schema.unitSelection.projectId, input.projectId), eq(schema.unitSelection.version, input.version ?? 0)))
            .returning();
          if (!row) throw conflict();
          sel = row;
        } else {
          [sel] = (await tx.insert(schema.unitSelection).values({ ...values, projectId: input.projectId, createdById: c.viewer.id }).returning()) as [typeof schema.unitSelection.$inferSelect];
        }
        await syncSelectionTask(tx, c, sel, u.unit, input.assigneeId);
        await audit(tx, c, sel.id, `${c.viewer.name} ${input.id ? "updated" : "added"} the ${input.category.toLowerCase()} selection for unit ${u.unit}`, input.id ? "update" : "create", priced);
        return { id: sel.id };
      });
    }),

  /** The buyer signed: record who and when, and the GC's task goes live. */
  signOff: projectProcedure("checklist.edit")
    .input(z.object({ id: z.uuid(), version: z.number().int().min(1), signedOffOn: planDate.nullable(), signedOffName: text(160).nullish() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      if (input.signedOffOn && input.signedOffOn > todayET()) throw new TRPCError({ code: "BAD_REQUEST", message: "A sign-off can't be in the future." });
      return ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .update(schema.unitSelection)
          .set({ signedOffOn: input.signedOffOn, signedOffName: input.signedOffOn ? input.signedOffName || null : null, version: sql`${schema.unitSelection.version} + 1`, updatedAt: new Date() })
          .where(and(eq(schema.unitSelection.id, input.id), eq(schema.unitSelection.projectId, input.projectId), eq(schema.unitSelection.version, input.version)))
          .returning();
        if (!row) throw conflict();
        const [u] = await tx.select({ unit: schema.saleUnit.unit }).from(schema.saleUnit).where(eq(schema.saleUnit.id, row.unitId));
        const taskId = await syncSelectionTask(tx, c, row, u!.unit, undefined);
        const [t] = await tx.select({ assigneeId: schema.task.assigneeId, title: schema.task.title }).from(schema.task).where(eq(schema.task.id, taskId));
        if (input.signedOffOn && t?.assigneeId && t.assigneeId !== c.viewer.id) {
          await notify(tx, c.viewer.id, [{ userId: t.assigneeId, kind: "comment", title: `Signed off: ${t.title}`, body: "The buyer signed off. Go ahead.", projectId: input.projectId, taskId, href: taskHref(input.projectId, taskId) }]);
        }
        await audit(tx, c, row.id, input.signedOffOn ? `${c.viewer.name} recorded the buyer's sign-off on the ${row.category.toLowerCase()} selection for unit ${u!.unit}` : `${c.viewer.name} cleared the sign-off on the ${row.category.toLowerCase()} selection for unit ${u!.unit}`);
        return { version: row.version };
      });
    }),

  deleteSelection: projectProcedure("checklist.edit")
    .input(z.object({ id: z.uuid(), version: z.number().int().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [row] = await tx.delete(schema.unitSelection).where(and(eq(schema.unitSelection.id, input.id), eq(schema.unitSelection.projectId, input.projectId), eq(schema.unitSelection.version, input.version))).returning();
        if (!row) throw conflict();
        // Its task goes too unless work has started on it.
        if (row.taskId) await tx.delete(schema.task).where(and(eq(schema.task.id, row.taskId), sql`${schema.task.status} in ('waiting', 'not_started')`));
        await audit(tx, c, row.id, `${c.viewer.name} removed the ${row.category.toLowerCase()} selection "${row.choice}"`, "delete");
        return { ok: true };
      });
    }),
});
