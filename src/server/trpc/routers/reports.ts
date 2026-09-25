import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { todayET } from "@/core/time";
import { planDate } from "../dates";
import { schema } from "../../db";
import { buildWeeklyReport, type WeeklyReportData } from "../../services/weekly-report";
import { globalProcedure, router } from "../init";

/** The weekly owner report (brief §7.8). Owner only: it carries headline financials. */
export const reportsRouter = router({
  /** Every week built so far, newest first. */
  list: globalProcedure("reports.view").query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({ weekOf: schema.weeklyReport.weekOf, generatedAt: schema.weeklyReport.generatedAt, data: schema.weeklyReport.data })
      .from(schema.weeklyReport)
      .orderBy(desc(schema.weeklyReport.weekOf))
      .limit(104);
    return rows.map((r) => ({ weekOf: r.weekOf, generatedAt: r.generatedAt, totals: (r.data as WeeklyReportData).totals }));
  }),

  /** One week as it was built on its Monday. */
  get: globalProcedure("reports.view")
    .input(z.object({ weekOf: planDate }))
    .query(async ({ ctx, input }) => {
      const [r] = await ctx.db.select().from(schema.weeklyReport).where(eq(schema.weeklyReport.weekOf, input.weekOf));
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "No report for that week" });
      return r.data as WeeklyReportData;
    }),

  /** The same report as things stand right now (the last seven days and the next two weeks). */
  live: globalProcedure("reports.view").query(({ ctx }) => buildWeeklyReport(ctx.db, todayET(), new Date(), { throughToday: true })),
});
