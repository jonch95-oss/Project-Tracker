import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import {
  buildTemplateParts,
  IMPORT_KINDS,
  MAX_IMPORT_ROWS,
  MAX_PROJECT_IMPORT_ROWS,
  validateRows,
  type RejectedRow,
} from "@/core/import";
import { templateDefSchema } from "@/core/template-schema";
import type { TemplateDef } from "@/core/templates";
import { schema } from "../../db";
import { recordAudit } from "../../services/audit";
import { assertValidTemplate } from "../../services/checklist";
import { projectAccess, protectedProcedure, requireProject, router } from "../init";

/** Validated rows, as validateRows leaves them: required fields present, optional ones present only when filled in. */
type ProjectRow = {
  name: string;
  address: string;
  type: (typeof PROJECT_TYPES)[number];
  borough?: "Brooklyn";
  bbl?: string;
  lotAreaSqft?: number;
  zoning?: string;
  residFar?: number;
  builtFar?: number;
  units?: number;
  grossSf?: number;
  sellableSf?: number;
  description?: string;
};
type BudgetRow = {
  category: string;
  name: string;
  originalCents: number;
  notes?: string;
};
type UnitRow = {
  unit: string;
  floor?: string;
  sf?: number;
  beds?: number;
  baths?: number;
  exposure?: string;
  outdoorType?: string;
  outdoorSf?: number;
  askCents?: number;
};
type VendorRow = {
  name: string;
  kind?: "contractor";
  trade?: string;
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  rating?: number;
  notes?: string;
};

const PROJECT_TYPES = [
  "ground_up_condo",
  "gut_renovation",
  "contract_flip",
  "foreclosure_auction",
  "condo_conversion",
] as const;

/** A procedure's refusal, in words for the row report. */
function reason(e: unknown): string {
  if (e instanceof TRPCError) {
    if (e.code === "FORBIDDEN")
      return e.message && e.message !== "FORBIDDEN"
        ? e.message
        : "You don't have permission for this.";
    // Unexpected failures never pass their internal text on.
    if (e.code === "INTERNAL_SERVER_ERROR") return "Couldn't save this row.";
    const zod = (
      e.cause as
        | { issues?: { message: string; path: (string | number)[] }[] }
        | undefined
    )?.issues;
    if (zod?.length)
      return zod.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
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
        rows: z
          .array(z.array(z.string().max(5000)).max(60))
          .max(MAX_IMPORT_ROWS),
        /** Each row's line number in the sheet, for the report. */
        rowNumbers: z
          .array(z.number().int().min(1).max(10_000_000))
          .max(MAX_IMPORT_ROWS)
          .optional(),
        mapping: z.record(
          z.string(),
          z.number().int().min(0).max(59).nullable(),
        ),
        projectId: z.uuid().optional(),
        companyId: z.uuid().optional(),
        templateName: z.string().trim().min(1).max(120).optional(),
        projectType: z.enum(PROJECT_TYPES).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.actor.role !== "owner" && ctx.actor.role !== "admin")
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Imports are for owners and admins.",
        });
      const { createCaller } = await import("../root");
      const caller = createCaller(ctx);
      if (
        input.kind === "projects" &&
        input.rows.length > MAX_PROJECT_IMPORT_ROWS
      )
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Import up to ${MAX_PROJECT_IMPORT_ROWS} projects at a time. Split the sheet.`,
        });
      // Into one project: they must be on it (the row procedures check their rights there too).
      const intoProject =
        input.kind === "budget" || input.kind === "units"
          ? input.projectId
          : undefined;
      if ((input.kind === "budget" || input.kind === "units") && !intoProject)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Choose the project.",
        });
      if (intoProject) {
        const access = await projectAccess(ctx, intoProject);
        // Budget lines are money: nothing about them (not even which names exist) without the right to edit them.
        if (input.kind === "budget") requireProject(access, "financials.edit");
      }
      const { valid, rejected } = validateRows(
        input.kind,
        input.rows,
        input.mapping,
        input.rowNumbers?.length === input.rows.length
          ? input.rowNumbers
          : undefined,
      );
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
        if (!input.companyId)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Choose the company the projects belong to.",
          });
        // A project with the same name and address is taken to be already there (e.g. the same sheet imported twice).
        const existing = new Set(
          (
            await ctx.db
              .select({
                name: schema.project.name,
                address: schema.project.address,
              })
              .from(schema.project)
          ).map(
            (p) =>
              `${p.name.trim().toLowerCase()}|${p.address.trim().toLowerCase()}`,
          ),
        );
        for (const v of valid) {
          const x = v.values as ProjectRow;
          const key = `${x.name.trim().toLowerCase()}|${x.address.trim().toLowerCase()}`;
          if (existing.has(key)) {
            failed.push({
              row: v.row,
              reasons: [
                "There's already a project with this name and address.",
              ],
            });
            continue;
          }
          existing.add(key);
          await one(v.row, () =>
            caller.projects.create({
              name: x.name,
              address: x.address,
              borough: x.borough ?? "Brooklyn",
              bbl: x.bbl ?? null,
              type: x.type,
              companyId: input.companyId!,
              toggles: [],
              facts: {
                lotAreaSqft: x.lotAreaSqft ?? null,
                zoning: x.zoning ?? null,
                residFar: x.residFar ?? null,
                builtFar: x.builtFar ?? null,
                units: x.units ?? null,
                grossSf: x.grossSf ?? null,
                sellableSf: x.sellableSf ?? null,
                description: x.description ?? null,
              },
            }),
          );
        }
      } else if (input.kind === "budget" || input.kind === "units") {
        const lines =
          input.kind === "budget"
            ? new Set(
                (
                  await ctx.db
                    .select({
                      category: schema.budgetLine.category,
                      name: schema.budgetLine.name,
                    })
                    .from(schema.budgetLine)
                    .where(eq(schema.budgetLine.projectId, intoProject!))
                ).map((l) => `${l.category}|${l.name.trim().toLowerCase()}`),
              )
            : new Set<string>();
        for (const v of valid) {
          const b = v.values as BudgetRow;
          const x = v.values as UnitRow;
          if (input.kind === "budget") {
            const key = `${b.category}|${b.name.trim().toLowerCase()}`;
            if (lines.has(key)) {
              failed.push({
                row: v.row,
                reasons: [
                  "This project already has a budget line with this name in this category.",
                ],
              });
              continue;
            }
            lines.add(key);
          }
          await one(v.row, () =>
            input.kind === "budget"
              ? caller.financials.saveLine({
                  projectId: input.projectId!,
                  category: b.category,
                  name: b.name,
                  originalCents: b.originalCents,
                  notes: b.notes ?? null,
                })
              : caller.units.saveUnit({
                  projectId: input.projectId!,
                  unit: x.unit,
                  floor: x.floor ?? null,
                  sf: x.sf ?? null,
                  beds: x.beds ?? null,
                  baths: x.baths ?? null,
                  exposure: x.exposure ?? null,
                  outdoorType: x.outdoorType ?? null,
                  outdoorSf: x.outdoorSf ?? null,
                  ...(x.askCents !== undefined ? { askCents: x.askCents } : {}),
                }),
          );
        }
      } else if (input.kind === "vendors") {
        for (const v of valid) {
          const x = v.values as VendorRow;
          await one(v.row, () =>
            caller.directory.saveVendor({
              name: x.name,
              kind: x.kind ?? "contractor",
              trade: x.trade ?? null,
              phone: x.phone ?? null,
              email: x.email ?? null,
              website: x.website ?? null,
              address: x.address ?? null,
              rating: x.rating ?? null,
              notes: x.notes ?? null,
            }),
          );
        }
      } else {
        // A template is all or nothing: its tasks refer to each other.
        if (!input.templateName || !input.projectType)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Name the template and choose its project type.",
          });
        const parts = buildTemplateParts(valid);
        failed.push(...parts.unresolved);
        if (parts.tasks.length) {
          const def = {
            name: input.templateName,
            projectType: input.projectType,
            phases: parts.phases,
            tasks: parts.tasks,
          } as TemplateDef;
          const checked = templateDefSchema.safeParse(def);
          let problem: string | null = checked.success
            ? null
            : (checked.error.issues[0]?.message ?? "check the rows");
          if (checked.success) {
            // The same checks saving does (e.g. tasks that wait on each other in a loop), before anything is created.
            try {
              assertValidTemplate(checked.data as TemplateDef);
            } catch (e) {
              problem = e instanceof TRPCError ? e.message : "check the rows";
            }
          }
          if (problem !== null) {
            for (const v of valid)
              if (!parts.unresolved.some((u) => u.row === v.row))
                failed.push({
                  row: v.row,
                  reasons: [`The template isn't valid: ${problem}`],
                });
          } else {
            let createdId: string | null = null;
            try {
              createdId = (
                await caller.templates.create({
                  name: input.templateName,
                  from: { projectType: input.projectType },
                })
              ).id;
              await caller.templates.save({
                templateId: createdId,
                version: 1,
                definition: checked.data as TemplateDef,
              });
              imported = parts.tasks.length;
            } catch (e) {
              // Don't leave a half-made template behind.
              if (createdId)
                await ctx.db
                  .update(schema.template)
                  .set({ archivedAt: new Date() })
                  .where(
                    and(
                      eq(schema.template.id, createdId),
                      isNull(schema.template.archivedAt),
                    ),
                  );
              for (const v of valid)
                if (!parts.unresolved.some((u) => u.row === v.row))
                  failed.push({ row: v.row, reasons: [reason(e)] });
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
        projectId: intoProject ?? null,
        summary: `${ctx.viewer.name} imported ${input.kind}: ${imported} of ${input.rows.length} rows`,
        data: {
          kind: input.kind,
          read: input.rows.length,
          valid: valid.length,
          imported,
          rejected: failed.length,
        },
        ip: ctx.ip,
      });
      return {
        read: input.rows.length,
        valid: valid.length,
        imported,
        rejected: failed,
      };
    }),
});
