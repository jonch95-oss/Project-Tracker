"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ErrorState } from "@/components/ui/architecture";
import { IconArrowLeft, IconChevronRight, IconPlus } from "@/components/ui/icons";
import { useToast } from "@/components/ui/overlay";
import { Button, buttonClass, Field, Input, Select, Skeleton, Textarea } from "@/components/ui/primitives";
import { manpowerTotal, MAX_LOG_RANGE_DAYS } from "@/core/field";
import { addDays, daysBetween, formatIsoDate, todayET } from "@/core/time";
import { cn } from "@/lib/cn";
import { cameraOptions } from "@/lib/camera";
import { photoUrl, uploadPhotos } from "@/lib/photo-upload";
import { errorMessage, useTRPC, useTRPCClient, type RouterOutputs } from "@/lib/trpc";

type Day = RouterOutputs["siteLogs"]["get"];
type Crew = { trade: string; company: string | null; count: number };
type Inspection = { what: string; result: "pass" | "fail" | "partial" | "pending"; notes: string | null };
type Delay = { cause: string; hours: number | null; notes: string | null };

const TRADES = ["General labor", "Carpentry", "Concrete", "Masonry", "Steel", "Electrical", "Plumbing", "HVAC", "Sprinkler", "Drywall", "Painting", "Roofing", "Demolition", "Excavation", "Other"];

/** Module D: one log per day, the super's two-minute form, with weather filled in and yesterday's crew one tap away. */
export function SiteLogView({ projectId, date, onDate }: { projectId: string; date: string | null; onDate: (d: string) => void }) {
  const today = todayET();
  const day = date && date <= today ? date : today;
  const trpc = useTRPC();
  const q = useQuery(trpc.siteLogs.get.queryOptions({ projectId, date: day }));
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_280px]">
      <section aria-labelledby="log-h" className="min-w-0">
        <div className="mb-6 flex items-center justify-between gap-3">
          <Button variant="ghost" size="sm" onClick={() => onDate(addDays(day, -1))} aria-label="Previous day">
            <IconArrowLeft size={16} />
          </Button>
          <h2 id="log-h" className="serif text-center text-heading">
            {day === today ? "Today" : formatIsoDate(day, { weekday: "short", month: "short", day: "numeric" })}
            <span className="num block text-[13px] font-normal text-muted">{formatIsoDate(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</span>
          </h2>
          <Button variant="ghost" size="sm" onClick={() => onDate(addDays(day, 1))} disabled={day >= today} aria-label="Next day">
            <IconChevronRight size={16} />
          </Button>
        </div>
        {q.isPending ? <Skeleton className="h-96 rounded-card" /> : q.isError ? <ErrorState onRetry={() => q.refetch()} /> : <LogForm key={`${day}-${q.data.log?.version ?? 0}`} projectId={projectId} day={day} data={q.data} />}
      </section>
      <RecentLogs projectId={projectId} current={day} onDate={onDate} />
    </div>
  );
}

function LogForm({ projectId, day, data }: { projectId: string; day: string; data: Day }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const toast = useToast();
  const log = data.log;
  const [crew, setCrew] = useState<Crew[]>(log?.manpower ?? []);
  const [inspections, setInspections] = useState<Inspection[]>(log?.inspections ?? []);
  const [delays, setDelays] = useState<Delay[]>(log?.delays ?? []);
  const [photoBusy, setPhotoBusy] = useState<string | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: trpc.siteLogs.get.queryKey({ projectId, date: day }) }), qc.invalidateQueries({ queryKey: trpc.siteLogs.list.queryKey() })]);
  const save = useMutation(trpc.siteLogs.save.mutationOptions({ onError: (e) => toast("error", errorMessage(e)) }));

  async function submit(form: HTMLFormElement, then?: (logId: string) => Promise<void>) {
    const f = new FormData(form);
    const s = (k: string) => String(f.get(k) ?? "").trim() || null;
    const r = await save.mutateAsync({
      projectId,
      date: day,
      version: log?.version,
      manpower: crew.filter((c) => c.trade.trim()),
      workPerformed: s("work"),
      deliveries: s("deliveries"),
      inspections: inspections.filter((i) => i.what.trim()),
      visitors: s("visitors"),
      safety: s("safety"),
      delays: delays.filter((d) => d.cause.trim()),
      notes: s("notes"),
    });
    if (then) await then(r.id);
    else toast("success", log ? "Log updated" : "Log filed");
    await refresh();
  }

  async function addPhotos(files: File[]) {
    const form = document.getElementById("site-log-form") as HTMLFormElement;
    setPhotoBusy(`0 of ${files.length}`);
    try {
      // Photos hang off the day's log: file it first if it's new.
      await submit(form, async (logId) => {
        const r = await uploadPhotos(client, projectId, files, { siteLogId: logId, ...(await cameraOptions()) }, (d, t) => setPhotoBusy(`${d} of ${t}`));
        for (const e of r.errors) toast("error", e);
        if (r.ids.length) toast("success", r.ids.length === 1 ? "Photo added" : `${r.ids.length} photos added`);
      });
    } catch {
      // save's onError already said why
    } finally {
      setPhotoBusy(null);
    }
  }

  const w = log?.weather;
  return (
    <form
      id="site-log-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(e.currentTarget).catch(() => undefined);
      }}
      className="flex flex-col gap-8"
    >
      <p className="num rounded-panel bg-sunken px-4 py-3 text-[13px] text-muted">
        {w ? (
          <>
            <span className="font-medium text-text">{w.summary}</span>
            {w.highF !== null ? ` · ${w.highF}° / ${w.lowF}°` : ""}
            {w.precipIn ? ` · ${w.precipIn}" rain` : ""}
            {w.windMph ? ` · wind ${w.windMph} mph` : ""} <span className="text-faint">({w.source === "open-meteo" ? "Open-Meteo" : "entered"})</span>
          </>
        ) : (
          "Weather fills in when the log is saved."
        )}
        {data.author && <span className="block">Last saved by {data.author}</span>}
      </p>

      <fieldset>
        <legend className="mb-3 flex w-full items-center justify-between text-[15px] font-medium">
          <span>
            Manpower <span className="num text-[13px] font-normal text-muted">{manpowerTotal(crew)} on site</span>
          </span>
          {crew.length === 0 && data.previousManpower.length > 0 && (
            <Button type="button" size="sm" variant="secondary" onClick={() => setCrew(data.previousManpower)}>
              Same crew as {formatIsoDate(data.previousDate!, { month: "short", day: "numeric" })}
            </Button>
          )}
        </legend>
        <div className="flex flex-col gap-2">
          {crew.map((c, i) => (
            <div key={i} className="grid grid-cols-[1fr_72px_auto] gap-2 sm:grid-cols-[1fr_1fr_80px_auto]">
              <Select aria-label="Trade" value={TRADES.includes(c.trade) ? c.trade : "Other"} onChange={(e) => setCrew(crew.map((x, j) => (j === i ? { ...x, trade: e.target.value } : x)))}>
                {TRADES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
              <Input aria-label="Company" placeholder="Company" className="hidden sm:block" value={c.company ?? ""} onChange={(e) => setCrew(crew.map((x, j) => (j === i ? { ...x, company: e.target.value || null } : x)))} />
              <Input aria-label="Count" type="number" inputMode="numeric" min={0} max={999} className="num" value={c.count} onChange={(e) => setCrew(crew.map((x, j) => (j === i ? { ...x, count: Math.max(0, Number(e.target.value) || 0) } : x)))} />
              <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${c.trade}`} onClick={() => setCrew(crew.filter((_, j) => j !== i))}>
                ✕
              </Button>
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setCrew([...crew, { trade: "General labor", company: null, count: 1 }])}>
            <IconPlus size={16} /> Add trade
          </Button>
        </div>
      </fieldset>

      <Field label="Work performed" htmlFor="sl-work">
        <Textarea id="sl-work" name="work" rows={3} maxLength={4000} defaultValue={log?.workPerformed ?? ""} placeholder="What got done today, by area or floor" />
      </Field>

      <fieldset>
        <legend className="mb-3 text-[15px] font-medium">Inspections</legend>
        <div className="flex flex-col gap-2">
          {inspections.map((x, i) => (
            <div key={i} className="grid grid-cols-[1fr_110px_auto] gap-2">
              <Input aria-label="Inspection" placeholder="e.g. DOB plumbing rough" value={x.what} onChange={(e) => setInspections(inspections.map((y, j) => (j === i ? { ...y, what: e.target.value } : y)))} />
              <Select aria-label="Result" value={x.result} onChange={(e) => setInspections(inspections.map((y, j) => (j === i ? { ...y, result: e.target.value as Inspection["result"] } : y)))}>
                <option value="pass">Pass</option>
                <option value="fail">Fail</option>
                <option value="partial">Partial</option>
                <option value="pending">Pending</option>
              </Select>
              <Button type="button" variant="ghost" size="sm" aria-label="Remove inspection" onClick={() => setInspections(inspections.filter((_, j) => j !== i))}>
                ✕
              </Button>
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setInspections([...inspections, { what: "", result: "pass", notes: null }])}>
            <IconPlus size={16} /> Add inspection
          </Button>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-[15px] font-medium">Delays</legend>
        <div className="flex flex-col gap-2">
          {delays.map((x, i) => (
            <div key={i} className="grid grid-cols-[1fr_80px_auto] gap-2">
              <Input aria-label="Cause" placeholder="e.g. Rain, late concrete" value={x.cause} onChange={(e) => setDelays(delays.map((y, j) => (j === i ? { ...y, cause: e.target.value } : y)))} />
              <Input aria-label="Hours lost" type="number" inputMode="decimal" min={0} max={24} placeholder="Hrs" className="num" value={x.hours ?? ""} onChange={(e) => setDelays(delays.map((y, j) => (j === i ? { ...y, hours: e.target.value === "" ? null : Math.min(24, Math.max(0, Number(e.target.value))) } : y)))} />
              <Button type="button" variant="ghost" size="sm" aria-label="Remove delay" onClick={() => setDelays(delays.filter((_, j) => j !== i))}>
                ✕
              </Button>
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setDelays([...delays, { cause: "", hours: null, notes: null }])}>
            <IconPlus size={16} /> Add delay
          </Button>
        </div>
      </fieldset>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Deliveries" htmlFor="sl-deliveries">
          <Textarea id="sl-deliveries" name="deliveries" rows={2} maxLength={2000} defaultValue={log?.deliveries ?? ""} />
        </Field>
        <Field label="Visitors" htmlFor="sl-visitors">
          <Textarea id="sl-visitors" name="visitors" rows={2} maxLength={2000} defaultValue={log?.visitors ?? ""} />
        </Field>
        <Field label="Safety incidents" htmlFor="sl-safety" hint="Leave blank if there were none.">
          <Textarea id="sl-safety" name="safety" rows={2} maxLength={2000} defaultValue={log?.safety ?? ""} />
        </Field>
        <Field label="Notes" htmlFor="sl-notes">
          <Textarea id="sl-notes" name="notes" rows={2} maxLength={4000} defaultValue={log?.notes ?? ""} />
        </Field>
      </div>

      <div>
        <h3 className="mb-3 text-[15px] font-medium">Photos</h3>
        {data.photos.length > 0 && (
          <ul className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {data.photos.map((p) => (
              <li key={p.id}>
                <a href={photoUrl(p.id, "full")} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-control border border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photoUrl(p.id)} alt={p.caption ?? "Site photo"} className="aspect-square w-full object-cover" loading="lazy" />
                </a>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={camera}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) void addPhotos(files);
          }}
        />
        <Button type="button" variant="secondary" loading={!!photoBusy} onClick={() => camera.current?.click()}>
          {photoBusy ? `Uploading ${photoBusy}` : "Take or add photos"}
        </Button>
      </div>

      <div className="sticky bottom-[calc(72px+env(safe-area-inset-bottom))] z-10 -mx-4 flex gap-3 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:px-0">
        <Button type="submit" className="flex-1 lg:flex-none" loading={save.isPending && !photoBusy}>
          {log ? "Save log" : "File today's log"}
        </Button>
      </div>
    </form>
  );
}

function RecentLogs({ projectId, current, onDate }: { projectId: string; current: string; onDate: (d: string) => void }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.siteLogs.list.queryOptions({ projectId, limit: 30 }));
  const today = todayET();
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(today);
  return (
    <aside aria-labelledby="recent-logs-h" className="min-w-0">
      <h3 id="recent-logs-h" className="mb-3 text-[15px] font-medium">
        Recent logs
      </h3>
      {q.data && q.data.length === 0 && <p className="text-[13px] text-muted">None yet.</p>}
      <ul className="divide-y divide-border rounded-card border border-border bg-surface">
        {(q.data ?? []).map((l) => (
          <li key={l.id}>
            <button type="button" onClick={() => onDate(l.date)} className={cn("flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-[13px] hover:bg-sunken/60", l.date === current && "bg-sunken")}>
              <span className="num font-medium">{formatIsoDate(l.date, { weekday: "short", month: "short", day: "numeric" })}</span>
              <span className="num text-muted">
                {l.crew} crew{l.failedInspections ? ` · ${l.failedInspections} failed` : ""}
                {l.incidents ? " · incident" : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-6 rounded-card border border-border bg-surface p-4">
        <h4 className="mb-3 text-[13px] font-medium">PDF for a draw or claim</h4>
        <div className="grid grid-cols-2 gap-2">
          <Input aria-label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="num" />
          <Input aria-label="To" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className="num" />
        </div>
        {from && to && from <= to && daysBetween(from, to) <= MAX_LOG_RANGE_DAYS ? (
          <a href={`/api/export/projects/${projectId}/site-logs?from=${from}&to=${to}`} className={buttonClass("secondary", "sm", "mt-3 w-full justify-center")}>
            Download PDF
          </a>
        ) : (
          <p className="mt-3 text-[13px] text-attention-text">Pick a range of six months or less.</p>
        )}
      </div>
    </aside>
  );
}
