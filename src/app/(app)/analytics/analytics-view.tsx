"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { useToast } from "@/components/ui/overlay";
import { Button, PageHeader, Panel, Skeleton } from "@/components/ui/primitives";
import { PROJECT_TYPE_LABEL, type ProjectTypeKey } from "@/core/labels";
import { formatMoney } from "@/core/money";
import { cn } from "@/lib/cn";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";

type Data = RouterOutputs["analytics"]["overview"];
const $sf = (c: number | null) => (c == null ? "—" : `${formatMoney(c, { whole: true })}/sf`);
const $ = (c: number) => formatMoney(c, { whole: true });
const typeLabel = (t: string) => PROJECT_TYPE_LABEL[t as ProjectTypeKey] ?? t;
const n1 = (x: number | null) => (x == null ? "—" : x.toLocaleString("en-US", { maximumFractionDigits: 1 }));

/** Module M: owner-only analytics across every project. */
export function AnalyticsView() {
  const trpc = useTRPC();
  const q = useQuery(trpc.analytics.overview.queryOptions());
  return (
    <>
      <PageHeader eyebrow="Owner" title="Analytics" description="How long phases really take, what projects cost per square foot, where budgets move, where work stalls, and how fast RFIs and invoices turn around." />
      {q.isPending ? (
        <Skeleton className="h-96 rounded-card" />
      ) : q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : (
        <div className="flex flex-col gap-8">
          <Turnaround data={q.data} />
          <Durations data={q.data} />
          <Costs data={q.data} />
          <Variance data={q.data} />
          <Stalls data={q.data} />
          <TemplateDurations />
        </div>
      )}
    </>
  );
}

function Turnaround({ data }: { data: Data }) {
  const t = data.turnaround;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Tile label="Average time to answer an RFI" value={t.rfi.avgDays == null ? "—" : `${n1(t.rfi.avgDays)} days`} note={t.rfi.answered ? `median ${n1(t.rfi.medianDays)} · ${t.rfi.answered} answered` : "No RFIs answered yet"} />
      <Tile label="Average time to approve an invoice" value={t.invoice.avgDays == null ? "—" : `${n1(t.invoice.avgDays)} days`} note={t.invoice.approved ? `median ${n1(t.invoice.medianDays)} · ${t.invoice.approved} approved` : "No invoices approved yet"} />
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-card border border-border bg-surface p-6">
      <p className="text-[13px] text-muted">{label}</p>
      <p className="num mt-2 text-[32px] font-medium leading-none">{value}</p>
      <p className="mt-2 text-[12px] text-muted">{note}</p>
    </div>
  );
}

/** One series of magnitudes: a bar per row, the number always printed beside it. */
function Bars({ rows, format, caption }: { rows: { label: string; value: number; tip: string }[]; format: (v: number) => string; caption: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <table className="w-full text-[14px]">
      <caption className="sr-only">{caption}</caption>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="group" title={r.tip}>
            <th scope="row" className="w-2/5 py-1.5 pr-3 text-left font-normal">
              {r.label}
            </th>
            <td className="py-1.5">
              <div className="flex items-center gap-3">
                <div className="h-3 flex-1">
                  <div className="h-3 rounded-r-[4px] bg-accent transition-opacity group-hover:opacity-80" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
                </div>
                <span className="num w-20 shrink-0 text-right text-muted">{format(r.value)}</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Durations({ data }: { data: Data }) {
  return (
    <Panel title="Days per phase" description="Median actual days from a phase's start to its finish, by project type (finished phases only).">
      {data.durations.length === 0 ? (
        <p className="text-[13px] text-muted">No finished phases yet.</p>
      ) : (
        <div className="grid gap-8 lg:grid-cols-2">
          {data.durations.map((d) => (
            <section key={d.type}>
              <h3 className="eyebrow mb-3">{typeLabel(d.type)}</h3>
              <Bars caption={`Median days per phase, ${typeLabel(d.type)}`} rows={d.phases.map((p) => ({ label: p.name, value: p.medianDays, tip: `${p.name}: median ${p.medianDays} days across ${p.n} project${p.n === 1 ? "" : "s"}` }))} format={(v) => `${n1(v)} d`} />
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Costs({ data }: { data: Data }) {
  return (
    <Panel title="Cost per square foot" description="Forecast cost (the larger of budget, committed and invoiced) and actual cost (invoices approved or paid), per gross and sellable sf. Benchmarks are the median by type.">
      {data.costs.length === 0 ? (
        <p className="text-[13px] text-muted">Add budgets and square footage to projects to see these.</p>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[640px] text-[14px]">
              <caption className="sr-only">Benchmarks by project type</caption>
              <thead className="text-left text-[12px] text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">Benchmark</th>
                  <th className="py-2 text-right font-medium">Hard / GSF</th>
                  <th className="py-2 text-right font-medium">Total / GSF</th>
                  <th className="py-2 text-right font-medium">Hard / SSF</th>
                  <th className="py-2 text-right font-medium">Total / SSF</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.benchmarks.map((b) => (
                  <tr key={b.type}>
                    <th scope="row" className="py-2 pr-3 text-left font-medium">
                      {typeLabel(b.type)} <span className="font-normal text-muted">({b.projects})</span>
                    </th>
                    <td className="py-2 text-right">{$sf(b.hardPerGsf)}</td>
                    <td className="py-2 text-right">{$sf(b.totalPerGsf)}</td>
                    <td className="py-2 text-right">{$sf(b.hardPerSsf)}</td>
                    <td className="py-2 text-right">{$sf(b.totalPerSsf)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[720px] text-[14px]">
              <caption className="sr-only">Cost per square foot by project</caption>
              <thead className="text-left text-[12px] text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">Project</th>
                  <th className="py-2 text-right font-medium">Hard / GSF forecast · actual</th>
                  <th className="py-2 text-right font-medium">Total / GSF forecast · actual</th>
                  <th className="py-2 text-right font-medium">Total / SSF forecast · actual</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.costs.map((c) => (
                  <tr key={c.projectId}>
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      {c.name}
                      <span className="block text-[12px] text-muted">{typeLabel(c.type)}</span>
                    </th>
                    <td className="py-2 text-right">
                      {$sf(c.hardPerGsf.forecast)} · <span className="text-muted">{$sf(c.hardPerGsf.actual)}</span>
                    </td>
                    <td className="py-2 text-right">
                      {$sf(c.totalPerGsf.forecast)} · <span className="text-muted">{$sf(c.totalPerGsf.actual)}</span>
                    </td>
                    <td className="py-2 text-right">
                      {$sf(c.totalPerSsf.forecast)} · <span className="text-muted">{$sf(c.totalPerSsf.actual)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}

function Variance({ data }: { data: Data }) {
  return (
    <Panel title="Budget variance by category" description="Across every project: the original budget, after approved changes, and what it's forecast to cost.">
      {data.variance.length === 0 ? (
        <p className="text-[13px] text-muted">No budgets yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="num w-full min-w-[600px] text-[14px]">
            <caption className="sr-only">Budget variance by category</caption>
            <thead className="text-left text-[12px] text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Category</th>
                <th className="py-2 text-right font-medium">Original</th>
                <th className="py-2 text-right font-medium">Revised</th>
                <th className="py-2 text-right font-medium">Forecast</th>
                <th className="py-2 text-right font-medium">Over / (under)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.variance.map((v) => (
                <tr key={v.category}>
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {v.label}
                  </th>
                  <td className="py-2 text-right">{$(v.original)}</td>
                  <td className="py-2 text-right">{$(v.revised)}</td>
                  <td className="py-2 text-right">{$(v.forecast)}</td>
                  <td className={cn("py-2 text-right", v.overBy > 0 ? "text-blocked-text" : v.overBy < 0 ? "text-done-text" : "text-muted")}>
                    {v.overBy > 0 ? `+${$(v.overBy)}` : v.overBy < 0 ? `(${$(-v.overBy)})` : "—"}
                    {v.pct !== null && v.overBy !== 0 && <span className="ml-1 text-[12px]">{v.pct > 0 ? `+${v.pct}` : v.pct}%</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function StallTable({ rows, caption, first }: { rows: Data["stalls"]["byPhase"]; caption: string; first: string }) {
  if (rows.length === 0) return <p className="text-[13px] text-muted">Nothing to show yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="num w-full min-w-[560px] text-[14px]">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-left text-[12px] text-muted">
          <tr>
            <th className="py-2 pr-3 font-medium">{first}</th>
            <th className="py-2 text-right font-medium">Overdue now</th>
            <th className="py-2 text-right font-medium">Waiting or blocked</th>
            <th className="py-2 text-right font-medium">Finished late</th>
            <th className="py-2 text-right font-medium">Avg days late</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.slice(0, 12).map((r) => (
            <tr key={r.key}>
              <th scope="row" className="py-2 pr-3 text-left font-normal">
                {r.label}
              </th>
              <td className={cn("py-2 text-right", r.overdueNow > 0 && "text-blocked-text")}>{r.overdueNow}</td>
              <td className="py-2 text-right">
                {r.stuckNow}
                {r.avgDaysStuck != null && <span className="text-[12px] text-muted"> · {n1(r.avgDaysStuck)} d</span>}
              </td>
              <td className="py-2 text-right">{r.lateShare == null ? "—" : `${r.lateShare}%`}</td>
              <td className="py-2 text-right">{n1(r.avgDaysLate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stalls({ data }: { data: Data }) {
  return (
    <Panel title="Where tasks stall" description="What's overdue or stuck waiting now, and how late finished work ran, by phase and by person.">
      <div className="grid gap-8 xl:grid-cols-2">
        <section>
          <h3 className="eyebrow mb-3">By phase</h3>
          <StallTable rows={data.stalls.byPhase} caption="Stalls by phase" first="Phase" />
        </section>
        <section>
          <h3 className="eyebrow mb-3">By person</h3>
          <StallTable rows={data.stalls.byPerson} caption="Stalls by person" first="Person" />
        </section>
      </div>
    </Panel>
  );
}

function TemplateDurations() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery(trpc.analytics.durationSuggestions.queryOptions());
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});
  const apply = useMutation(
    trpc.analytics.applyDurations.mutationOptions({
      onSuccess: async (r) => {
        toast("success", `Template updated (version ${r.version}): ${r.changed} duration${r.changed === 1 ? "" : "s"}`);
        setPicked({});
        await qc.invalidateQueries({ queryKey: trpc.analytics.durationSuggestions.queryKey() });
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  return (
    <Panel title="Update template durations from actuals" description="Where a template task has taken noticeably longer or shorter on three or more projects, here's the median it actually took from its phase's start. Pick the ones to adopt; new projects use them.">
      {q.isPending ? (
        <Skeleton className="h-24" />
      ) : q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="Nothing to update yet" body="Suggestions appear once a template's tasks have been done on three or more projects." />
      ) : (
        <div className="flex flex-col gap-8">
          {q.data.map((t) => {
            const sel = picked[t.templateId] ?? new Set<string>();
            const toggle = (k: string) => setPicked((p) => ({ ...p, [t.templateId]: new Set(sel.has(k) ? [...sel].filter((x) => x !== k) : [...sel, k]) }));
            return (
              <section key={t.templateId}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-medium">
                    {t.name} <span className="text-[13px] font-normal text-muted">· version {t.version}</span>
                  </h3>
                  <Button
                    size="sm"
                    disabled={sel.size === 0}
                    loading={apply.isPending && apply.variables?.templateId === t.templateId}
                    onClick={() => apply.mutate({ templateId: t.templateId, version: t.version, changes: t.suggestions.filter((s) => sel.has(s.templateKey)).map((s) => ({ templateKey: s.templateKey, days: s.suggestedDays })) })}
                  >
                    Apply {sel.size || ""} to the template
                  </Button>
                </div>
                <ul className="divide-y divide-border rounded-panel border border-border">
                  {t.suggestions.map((s) => (
                    <li key={s.templateKey}>
                      <label className="flex cursor-pointer items-center gap-3 px-4 py-3">
                        <input type="checkbox" checked={sel.has(s.templateKey)} onChange={() => toggle(s.templateKey)} className="size-4 accent-[var(--accent)]" />
                        <span className="min-w-0 flex-1 text-[14px]">{s.title}</span>
                        <span className="num shrink-0 text-[13px] text-muted">
                          {s.currentDays} → <span className="font-medium text-text">{s.suggestedDays}</span> {s.unit === "business" ? "business " : ""}days · {s.samples} projects
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
