import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { buildTemplateParts, IMPORT_KINDS, MAX_IMPORT_ROWS, validateRows, type RejectedRow } from "@/core/import";
import { templateDefSchema } from "@/core/template-schema";
import type { TemplateDef } from "@/core/templates";
import { recordAudit } from "../../services/audit";
import { protectedProcedure, router } from "../init";

/** Validated rows, as validateRows leaves them: required fields present, optional ones present only when filled in. */
type ProjectRow = { name: string; address: string; type: (typeof PROJECT_TYPES)[number]; borough?: "Brooklyn"; bbl?: string; lotAreaSqft?: number; zoning?: string; residFar?: number; builtFar?: number; units?: number; grossSf?: number; sellableSf?: number; description?: string };
type BudgetRow = { category: string; name: string; originalCents: number; notes?: string };
type UnitRow = { unit: string; floor?: string; sf?: number; beds?: number; baths?: number; exposure?: string; outdoorType?: string; outdoorSf?: number; askCents?: number };
type VendorRow = { name: string; kind?: "contractor"; trade?: string; phone?: string; email?: string; website?: string; address?: string; rating?: number; notes?: string };

const PROJECT_TYPES = ["ground_up_condo", "gut_renovation", "contract_flip", "foreclosure_auction", "condo_conversion"] as const;

/** A procedure's refusal, in words for the row report. */
function reason(e: unknown): string {
  if (e instanceof TRPCError) {
    if (e.code === "FORBIDDEN") return e.message && e.message !== "FORBIDDEN" ? e.message : "You don't have permission for this.";
    const zod = (e.cause as { issues?: { message: string; path: (string | number)[] }[] } | undefined)?.issues;
    if (zod?.length) return zod.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return e.message;
  }
  return "Couldn't save this row.";
}

/**
 * Module N, step 3: import the mapped rows. Every row is validated again
 * here with the same rules as the preview, then saved through the normal
 * procedures as the person importing (so their permissions, numbering and
 * side effects all apply). The answer counts rows read, valid, imported and
 * rejected, each rejected row with its reasons.
 */
export const importRouter = router({
  commit: protectedProcedure
    .input(
      z.object({
        kind: z.enum(IMPORT_KINDS),
        rows: z.array(z.array(z.string().max(5000)).max(60)).max(MAX_IMPORT_ROWS),
        mapping: z.record(z.string(), z.number().int().min(0).max(59).nullable()),
        projectId: z.uuid().optional(),
        companyId: z.uuid().optional(),
        templateName: z.string().trim().min(1).max(120).optional(),
        projectType: z.enum(PROJECT_TYPES).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.actor.role !== "owner" && ctx.actor.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Imports are for owners and admins." });
      const { createCaller } = await import("../root");
      const caller = createCaller(ctx);
      const { valid, rejected } = validateRows(input.kind, input.rows, input.mapping);
      const failed: RejectedRow[] = [...rejected];
      let imported = 0;
      const one = async (row: number, fn: () => Promise<unknown>) => {
        try {
          await fn();
          imported++;
        } catch (e) {
          failed.push({ row, reasons: [reason(e)] });
        }
      };

      if (input.kind === "projects") {
        if (!input.companyId) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose the company the projects belong to." });
        for (const v of valid) {
          const x = v.values as ProjectRow;
          await one(v.row, () =>
            caller.projects.create({
              name: x.name,
              address: x.address,
              borough: x.borough ?? "Brooklyn",
              bbl: x.bbl ?? null,
              type: x.type,
              companyId: input.companyId!,
              toggles: [],
              facts: { lotAreaSqft: x.lotAreaSqft ?? null, zoning: x.zoning ?? null, residFar: x.residFar ?? null, builtFar: x.builtFar ?? null, units: x.units ?? null, grossSf: x.grossSf ?? null, sellableSf: x.sellableSf ?? null, description: x.description ?? null },
            }),
          );
        }
      } else if (input.kind === "budget" || input.kind === "units") {
        if (!input.projectId) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose the project." });
        for (const v of valid) {
          const b = v.values as BudgetRow;
          const x = v.values as UnitRow;
          await one(v.row, () =>
            input.kind === "budget"
              ? caller.financials.saveLine({ projectId: input.projectId!, category: b.category, name: b.name, originalCents: b.originalCents, notes: b.notes ?? null })
              : caller.units.saveUnit({ projectId: input.projectId!, unit: x.unit, floor: x.floor ?? null, sf: x.sf ?? null, beds: x.beds ?? null, baths: x.baths ?? null, exposure: x.exposure ?? null, outdoorType: x.outdoorType ?? null, outdoorSf: x.outdoorSf ?? null, ...(x.askCents !== undefined ? { askCents: x.askCents } : {}) }),
          );
        }
      } else if (input.kind === "vendors") {
        for (const v of valid) {
          const x = v.values as VendorRow;
          await one(v.row, () => caller.directory.saveVendor({ name: x.name, kind: x.kind ?? "contractor", trade: x.trade ?? null, phone: x.phone ?? null, email: x.email ?? null, website: x.website ?? null, address: x.address ?? null, rating: x.rating ?? null, notes: x.notes ?? null }));
        }
      } else {
        // A template is all or nothing: its tasks refer to each other.
        if (!input.templateName || !input.projectType) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the template and choose its project type." });
        const parts = buildTemplateParts(valid);
        failed.push(...parts.unresolved);
        if (parts.tasks.length) {
          const def = { name: input.templateName, projectType: input.projectType, phases: parts.phases, tasks: parts.tasks } as TemplateDef;
          const checked = templateDefSchema.safeParse(def);
          if (!checked.success) {
            for (const v of valid) if (!parts.unresolved.some((u) => u.row === v.row)) failed.push({ row: v.row, reasons: [`The template isn't valid: ${checked.error.issues[0]?.message ?? "check the rows"}`] });
          } else {
            try {
              const { id } = await caller.templates.create({ name: input.templateName, from: { projectType: input.projectType } });
              await caller.templates.save({ templateId: id, version: 1, definition: checked.data as TemplateDef });
              imported = parts.tasks.length;
            } catch (e) {
              for (const v of valid) if (!parts.unresolved.some((u) => u.row === v.row)) failed.push({ row: v.row, reasons: [reason(e)] });
            }
          }
        }
      }

      failed.sort((a, b) => a.row - b.row);
      await recordAudit(ctx.db, {
        actorId: ctx.viewer.id,
        actorName: ctx.viewer.name,
        action: "create",
        entityType: "import",
        entityId: ctx.viewer.id,
        projectId: input.projectId ?? null,
        summary: `${ctx.viewer.name} imported ${input.kind}: ${imported} of ${input.rows.length} rows`,
        data: { kind: input.kind, read: input.rows.length, valid: valid.length, imported, rejected: failed.length },
        ip: ctx.ip,
      });
      return { read: input.rows.length, valid: valid.length, imported, rejected: failed };
    }),
});
