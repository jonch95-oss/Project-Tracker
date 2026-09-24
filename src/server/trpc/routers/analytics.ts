import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DueRule, TemplateDef } from "@/core/templates";
import { schema } from "../../db";
import { durationSuggestions, portfolioAnalytics } from "../../services/analytics";
import { recordAudit } from "../../services/audit";
import { assertValidTemplate, loadTemplate } from "../../services/checklist";
import { globalProcedure, router } from "../init";

/** Module M: owner-only analytics across the portfolio, and template durations learned from what actually happened. */
export const analyticsRouter = router({
  overview: globalProcedure("analytics.view").query(({ ctx }) => portfolioAnalytics(ctx.db)),

  durationSuggestions: globalProcedure("analytics.view").query(({ ctx }) => durationSuggestions(ctx.db)),

  /** Save chosen suggestions as a new template version (new projects use it; existing ones follow via "update from template"). */
  applyDurations: globalProcedure("analytics.view")
    .input(z.object({ templateId: z.uuid(), version: z.number().int().min(1), changes: z.array(z.object({ templateKey: z.string().min(1).max(80), days: z.number().int().min(0).max(3650) })).min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const t = await loadTemplate(ctx.db, input.templateId);
      if (!t) throw new TRPCError({ code: "NOT_FOUND" });
      const def = structuredClone(t.def) as TemplateDef;
      const want = new Map(input.changes.map((c) => [c.templateKey, c.days]));
      let changed = 0;
      for (const k of def.tasks) {
        const days = want.get(k.key);
        if (days === undefined || !k.due || k.due.from !== "phase_start") continue;
        (k.due as DueRule).days = days;
        changed++;
      }
      if (changed === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "None of those tasks count from their phase's start in this template." });
      assertValidTemplate(def);
      return ctx.db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.template)
          .set({ definition: def, version: sql`${schema.template.version} + 1`, updatedAt: new Date() })
          .where(and(eq(schema.template.id, input.templateId), eq(schema.template.version, input.version)))
          .returning({ version: schema.template.version });
        if (!updated.length) throw new TRPCError({ code: "CONFLICT", message: "The template changed a moment ago. Reload to see the latest." });
        const version = updated[0]!.version;
        await tx.insert(schema.templateRevision).values({ templateId: input.templateId, version, definition: def, savedById: ctx.viewer.id });
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "update",
          entityType: "template",
          entityId: input.templateId,
          summary: `${ctx.viewer.name} updated ${changed} task duration${changed === 1 ? "" : "s"} in ${def.name} from actuals (version ${version})`,
          data: { changes: input.changes },
          ip: ctx.ip,
        });
        return { version, changed };
      });
    }),
});
