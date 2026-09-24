"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { IconPaperclip, IconPlus } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Input, Select, Skeleton, StatusPill, Textarea, type Tone } from "@/components/ui/primitives";
import { BUDGET_CATEGORIES, byCategory, categoryLabel, DRAW_STATUS_LABEL, UNCODED, UNIT_STATUS_LABEL, UNIT_STATUSES, type DrawStatus, type UnitStatus } from "@/core/financials";
import { centsToInput, FieldError, optionalInt, optionalMoney, optionalPercentBps, optionalSignedMoney } from "@/core/forms";
import { formatBasisPoints, formatMoney, formatMultiple, sum } from "@/core/money";
import { formatIsoDate, todayET } from "@/core/time";
import { cn } from "@/lib/cn";
import { useFileUpload } from "@/lib/file-upload";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";
import { FileSheet } from "./files-tab";

type Data = RouterOutputs["financials"]["overview"];
type Section = "summary" | "budget" | "commitments" | "invoices" | "changes" | "draws" | "sales";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "summary", label: "Summary" },
  { key: "budget", label: "Budget" },
  { key: "commitments", label: "Commitments" },
  { key: "invoices", label: "Invoices" },
  { key: "changes", label: "Change orders" },
  { key: "draws", label: "Draws" },
  { key: "sales", label: "Sales" },
];

const $ = (c: number | null | undefined, whole = true) => (c == null ? "—" : formatMoney(c, { whole }));
const d = (iso: string | null | undefined) => (iso ? formatIsoDate(iso, { month: "short", day: "numeric", year: iso.slice(0, 4) === todayET().slice(0, 4) ? undefined : "numeric" }) : "—");

function useInvalidate(projectId: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.financials.overview.queryKey({ projectId }) }),
      qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ projectId }) }),
      qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() }),
    ]);
}

/** Financials (brief §8), gated by financial visibility on the project. */
export function FinancialsTab({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.financials.overview.queryOptions({ projectId }));
  const [section, setSection] = useState<Section>("summary");
  if (q.isPending) return <Skeleton className="h-96 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const data = q.data;
  return (
    <section aria-labelledby="fin-h">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <h2 id="fin-h" className="serif text-heading">
          Financials
        </h2>
        {data.access.canExport && (
          <a href={`/api/export/projects/${projectId}`} className="inline-flex h-9 items-center rounded-control border border-control px-3 text-[13px] font-medium hover:bg-sunken">
            Export to Excel
          </a>
        )}
      </div>
      {data.broken && (
        <p role="alert" className="mb-4 rounded-panel bg-blocked-tint/60 px-4 py-3 text-[13px] text-blocked-text">
          Some amounts on this project are too large to total. Check for a mistyped figure.
        </p>
      )}
      <Tabs<Section> idBase="fin-tabs" label="Financial sections" items={SECTIONS} value={section} onChange={setSection} className="mb-6" />
      <TabPanel idBase="fin-tabs" tab={section} className="focus-visible:outline-offset-8">
        {section === "summary" && <Summary projectId={projectId} data={data} onGo={setSection} />}
        {section === "budget" && <Budget projectId={projectId} data={data} />}
        {section === "commitments" && <Commitments projectId={projectId} data={data} />}
        {section === "invoices" && <Invoices projectId={projectId} data={data} />}
        {section === "changes" && <ChangeOrders projectId={projectId} data={data} />}
        {section === "draws" && <Draws projectId={projectId} data={data} />}
        {section === "sales" && <Sales projectId={projectId} data={data} />}
      </TabPanel>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

function Summary({ projectId, data, onGo }: { projectId: string; data: Data; onGo: (s: Section) => void }) {
  const h = data.headline;
  const [editing, setEditing] = useState(false);
  const figures: [string, ReactNode, string?][] = [
    ["Purchase price", $(h.purchasePrice)],
    ["Total project budget", $(h.totalBudget), h.totalBudget == null ? undefined : data.sources.budgetFromLines ? "from the budget" : "typed in"],
    ["Spent to date", $(h.spentToDate)],
    ["Committed", $(h.committed)],
    ["Forecast at completion", $(h.forecastAtCompletion)],
    ["Projected sellout", $(h.projectedSellout), h.projectedSellout == null ? undefined : data.sources.selloutFromUnits ? "from the unit schedule" : "typed in"],
    ["Profit", $(h.profit)],
    ["Margin", formatBasisPoints(h.marginBps)],
    ["Equity required", $(h.equityRequired)],
    ["Equity multiple", formatMultiple(h.equityMultipleMilli)],
  ];
  const groups = byCategory([...data.lines.map((l) => l.totals), ...(data.uncoded ? [data.uncoded] : [])]);
  return (
    <div className="flex flex-col gap-8">
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-[15px] font-medium">Headline</h3>
          {data.access.canEdit && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit figures
            </Button>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {figures.map(([k, v, note]) => (
            <div key={k} className="min-w-0 rounded-card border border-border bg-surface p-4">
              <dt className="text-[12px] text-muted">{k}</dt>
              <dd className={cn("num mt-1 truncate text-[17px] font-medium", k === "Profit" && h.profit != null && h.profit < 0 && "text-blocked-text")}>{v}</dd>
              {note && <dd className="text-[11px] text-faint">{note}</dd>}
            </div>
          ))}
        </dl>
      </div>
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-[15px] font-medium">Budget by category</h3>
          <Button variant="ghost" size="sm" onClick={() => onGo("budget")}>
            Open budget
          </Button>
        </div>
        {groups.length === 0 ? (
          <p className="text-sm text-muted">No budget yet.</p>
        ) : (
          <MoneyTable
            head={["Category", "Revised", "Committed", "Paid", "Forecast", "Variance"]}
            rows={groups.map((g) => [categoryLabel(g.category), $(g.totals.revised), $(g.totals.committed), $(g.totals.paid), $(g.totals.forecast), <Variance key="v" cents={g.totals.variance} />])}
            foot={data.budget ? ["Total", $(data.budget.revised), $(data.budget.committed), $(data.budget.paid), $(data.budget.forecast), <Variance key="v" cents={data.budget.variance} />] : undefined}
          />
        )}
      </div>
      {editing && <HeadlineDialog projectId={projectId} data={data} onClose={() => setEditing(false)} />}
    </div>
  );
}

function Variance({ cents }: { cents: number }) {
  return <span className={cn(cents < 0 && "font-medium text-blocked-text")}>{cents === 0 ? "—" : cents < 0 ? `${$(-cents)} over` : `${$(cents)} under`}</span>;
}

function MoneyTable({ head, rows, foot, onRow }: { head: string[]; rows: ReactNode[][]; foot?: ReactNode[]; onRow?: (i: number) => void }) {
  return (
    <div className="overflow-x-auto rounded-card border border-border bg-surface">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[12px] text-muted">
            {head.map((h, i) => (
              <th key={h} scope="col" className={cn("px-4 py-2.5 font-medium", i > 0 && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r, i) => (
            <tr key={i} className={cn(onRow && "cursor-pointer hover:bg-sunken/60")} onClick={onRow ? () => onRow(i) : undefined}>
              {r.map((c, j) => (
                <td key={j} className={cn("px-4 py-2.5", j > 0 && "num text-right")}>
                  {j === 0 && onRow ? (
                    <button type="button" className="text-left underline-offset-4 hover:underline" onClick={(e) => (e.stopPropagation(), onRow(i))}>
                      {c}
                    </button>
                  ) : (
                    c
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {foot && (
          <tfoot>
            <tr className="border-t border-border font-medium">
              {foot.map((c, j) => (
                <td key={j} className={cn("px-4 py-2.5", j > 0 && "num text-right")}>
                  {c}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared form bits                                                    */
/* ------------------------------------------------------------------ */

/** A form in a dialog: gathers values, shows field errors, saves. */
function FormDialog({
  title,
  onClose,
  onSubmit,
  busy,
  children,
  onDelete,
  deleteLabel = "Delete",
  error,
}: {
  title: string;
  onClose: () => void;
  onSubmit: (f: FormData) => void;
  busy: boolean;
  children: ReactNode;
  onDelete?: () => void;
  deleteLabel?: string;
  error?: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <>
          {onDelete && (
            <Button variant="danger" className="mr-auto" onClick={() => setConfirming(true)}>
              {deleteLabel}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="fin-form" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="fin-form"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          onSubmit(new FormData(e.currentTarget));
        }}
        className="grid gap-5 sm:grid-cols-2"
      >
        {error && (
          <p role="alert" className="rounded-panel bg-blocked-tint/60 px-3 py-2 text-[13px] text-blocked-text sm:col-span-2">
            {error}
          </p>
        )}
        {children}
      </form>
      {onDelete && (
        <ConfirmDialog
          open={confirming}
          title={`${deleteLabel}?`}
          body="This can't be undone. It's recorded in the activity log."
          confirmLabel={deleteLabel}
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onDelete();
          }}
        />
      )}
    </Dialog>
  );
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function MoneyField({ name, label, value, required, hint, className }: { name: string; label: string; value?: number | null; required?: boolean; hint?: string; className?: string }) {
  return (
    <Field label={label} htmlFor={`fin-${name}`} hint={hint} className={className}>
      <Input id={`fin-${name}`} name={name} inputMode="decimal" required={required} defaultValue={centsToInput(value)} placeholder="$0" className="num" autoComplete="off" />
    </Field>
  );
}

function LineSelect({ data, value, name = "budgetLineId", label = "Budget line" }: { data: Data; value?: string | null; name?: string; label?: string }) {
  return (
    <Field label={label} htmlFor={`fin-${name}`}>
      <Select id={`fin-${name}`} name={name} defaultValue={value ?? ""}>
        <option value="">Not coded yet</option>
        {BUDGET_CATEGORIES.map((c) => {
          const lines = data.lines.filter((l) => l.category === c.key);
          if (!lines.length) return null;
          return (
            <optgroup key={c.key} label={c.label}>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </optgroup>
          );
        })}
      </Select>
    </Field>
  );
}

/** Pick or upload the PDF for an invoice, contract or change order. It lives in the gated Financial folder. */
function PdfField({ projectId, value, onChange, readOnly }: { projectId: string; value: string | null; onChange: (id: string | null) => void; readOnly?: boolean }) {
  const trpc = useTRPC();
  const toast = useToast();
  const folders = useQuery(trpc.files.folders.queryOptions({ projectId }));
  const fin = folders.data?.folders.find((f) => f.gated);
  const up = useFileUpload(projectId);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="sm:col-span-2">
      <p className="mb-2 text-[13px] font-medium">Document</p>
      <div className="flex flex-wrap items-center gap-2">
        {value ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
              <IconPaperclip size={16} /> View document
            </Button>
            {!readOnly && (
              <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
                Remove
              </Button>
            )}
          </>
        ) : readOnly ? null : (
          <Button variant="secondary" size="sm" disabled={!fin} loading={up.busy} onClick={() => input.current?.click()}>
            <IconPlus size={16} /> Upload PDF
          </Button>
        )}
        <input
          ref={input}
          type="file"
          accept="application/pdf,image/*"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file || !fin) return;
            const r = await up.upload([file], { folderId: fin.id });
            if (r.lastFileId) {
              onChange(r.lastFileId);
              toast("success", "Uploaded to the Financial folder");
            }
          }}
        />
        {!readOnly && <span className="text-[12px] text-muted">Saved in the restricted Financial folder.</span>}
      </div>
      {up.items.some((i) => i.state === "error") && <p className="mt-1 text-[12px] text-blocked-text">{up.items.find((i) => i.error)?.error}</p>}
      {open && value && <FileSheet projectId={projectId} fileId={value} folders={folders.data?.folders ?? []} onClose={() => setOpen(false)} />}
    </div>
  );
}

function useSaver<V>(mutate: (v: V, opts: { onSuccess: () => void; onError: (e: unknown) => void }) => void) {
  const [error, setError] = useState<string | null>(null);
  const run = (build: () => V, onDone: () => void) => {
    setError(null);
    let v: V;
    try {
      v = build();
    } catch (e) {
      setError(e instanceof FieldError ? e.message : errorMessage(e));
      return;
    }
    mutate(v, { onSuccess: onDone, onError: (e) => setError(errorMessage(e)) });
  };
  return { error, run };
}

/* ------------------------------------------------------------------ */
/* Headline figures                                                    */
/* ------------------------------------------------------------------ */

function HeadlineDialog({ projectId, data, onClose }: { projectId: string; data: Data; onClose: () => void }) {
  const trpc = useTRPC();
  const invalidate = useInvalidate(projectId);
  const save = useMutation(trpc.financials.saveHeadline.mutationOptions({ onSettled: invalidate }));
  const { error, run } = useSaver(save.mutate);
  const t = data.typed;
  return (
    <FormDialog
      title="Headline figures"
      onClose={onClose}
      busy={save.isPending}
      error={error}
      onSubmit={(f) =>
        run(
          () => ({
            projectId,
            purchasePriceCents: optionalMoney(str(f, "pp"), "pp", "Purchase price"),
            totalBudgetCents: optionalMoney(str(f, "tb"), "tb", "Total budget"),
            projectedSelloutCents: optionalMoney(str(f, "ps"), "ps", "Projected sellout"),
            loanAmountCents: optionalMoney(str(f, "loan"), "loan", "Loan amount"),
            useBudgetDetail: f.get("useBudget") === "on",
            useSalesDetail: f.get("useSales") === "on",
            version: t.version,
          }),
          onClose,
        )
      }
    >
      <MoneyField name="pp" label="Purchase price" value={t.purchasePriceCents} />
      <MoneyField name="loan" label="Loan amount (senior debt)" value={t.loanAmountCents} hint="Used for equity required and the equity multiple." />
      <MoneyField name="tb" label="Total project budget" value={t.totalBudgetCents} hint="Used until the budget lines are switched on below." />
      <MoneyField name="ps" label="Projected sellout" value={t.projectedSelloutCents} hint="Used until the unit schedule is switched on below." />
      <label className="flex items-start gap-3 text-sm sm:col-span-2">
        <input type="checkbox" name="useBudget" defaultChecked={t.useBudgetDetail} className="mt-0.5 size-4 accent-[var(--accent)]" />
        <span>
          Use the budget lines for the total budget and forecast
          <span className="block text-[12px] text-muted">Switch on once the budget is complete, so a half-entered budget never replaces the typed figure.</span>
        </span>
      </label>
      <label className="flex items-start gap-3 text-sm sm:col-span-2">
        <input type="checkbox" name="useSales" defaultChecked={t.useSalesDetail} className="mt-0.5 size-4 accent-[var(--accent)]" />
        <span>
          Use the unit schedule for projected sellout
          <span className="block text-[12px] text-muted">Switch on once every unit is entered.</span>
        </span>
      </label>
    </FormDialog>
  );
}

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

type Line = Data["lines"][number];

function Budget({ projectId, data }: { projectId: string; data: Data }) {
  const trpc = useTRPC();
  const toast = useToast();
  const invalidate = useInvalidate(projectId);
  const [editing, setEditing] = useState<Line | { category: string } | null>(null);
  const start = useMutation(trpc.financials.startBudget.mutationOptions({ onError: (e) => toast("error", errorMessage(e)), onSettled: invalidate }));
  if (data.lines.length === 0) {
    return (
      <EmptyState
        title="No budget yet"
        body="Start with one line per category (acquisition, closing, soft, hard, financing, contingency, sales & marketing), then split them up."
        action={
          data.access.canEdit ? (
            <Button onClick={() => start.mutate({ projectId })} loading={start.isPending}>
              Start the budget
            </Button>
          ) : null
        }
      />
    );
  }
  const groups = byCategory([...data.lines.map((l) => l.totals), ...(data.uncoded ? [data.uncoded] : [])]);
  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <div key={g.category}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-[15px] font-medium">{categoryLabel(g.category)}</h3>
            {data.access.canEdit && g.category !== UNCODED && (
              <Button variant="ghost" size="sm" onClick={() => setEditing({ category: g.category })}>
                <IconPlus size={16} /> Line
              </Button>
            )}
          </div>
          <MoneyTable
            head={["Line", "Original", "Changes", "Revised", "Committed", "Invoiced", "Paid", "Variance"]}
            rows={g.lines.map((t) => {
              const l = data.lines.find((x) => x.id === t.id);
              return [l?.name ?? "Contracts and invoices without a line", $(t.original), t.approvedChanges ? $(t.approvedChanges) : "—", $(t.revised), $(t.committed), $(t.invoiced), $(t.paid), <Variance key="v" cents={t.variance} />];
            })}
            foot={["Subtotal", $(g.totals.original), g.totals.approvedChanges ? $(g.totals.approvedChanges) : "—", $(g.totals.revised), $(g.totals.committed), $(g.totals.invoiced), $(g.totals.paid), <Variance key="v" cents={g.totals.variance} />]}
            onRow={data.access.canEdit && g.category !== UNCODED ? (i) => setEditing(data.lines.find((x) => x.id === g.lines[i]!.id)!) : undefined}
          />
        </div>
      ))}
      {data.access.canEdit && groups.filter((g) => g.category !== UNCODED).length < BUDGET_CATEGORIES.length && (
        <Select aria-label="Add a line in another category" value="" onChange={(e) => e.target.value && setEditing({ category: e.target.value })} className="max-w-xs">
          <option value="">Add a line in another category…</option>
          {BUDGET_CATEGORIES.filter((c) => !groups.some((g) => g.category === c.key)).map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </Select>
      )}
      {editing && <LineDialog projectId={projectId} line={"id" in editing ? editing : null} category={editing.category} onClose={() => setEditing(null)} />}
    </div>
  );
}

function LineDialog({ projectId, line, category, onClose }: { projectId: string; line: Line | null; category: string; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const invalidate = useInvalidate(projectId);
  const save = useMutation(trpc.financials.saveLine.mutationOptions({ onSettled: invalidate }));
  const del = useMutation(trpc.financials.deleteLine.mutationOptions({ onSuccess: onClose, onError: (e) => toast("error", errorMessage(e)), onSettled: invalidate }));
  const { error, run } = useSaver(save.mutate);
  return (
    <>
      <FormDialog
        title={line ? `Edit ${line.name}` : `New ${categoryLabel(category).toLowerCase()} line`}
        onClose={onClose}
        busy={save.isPending}
        error={error}
        onDelete={line ? () => del.mutate({ projectId, id: line.id, version: line.version }) : undefined}
        deleteLabel="Remove line"
        onSubmit={(f) =>
          run(
            () => ({
              projectId,
              id: line?.id,
              version: line?.version,
              category: str(f, "category"),
              name: str(f, "name"),
              originalCents: optionalSignedMoney(str(f, "original"), "original", "Original budget") ?? 0,
              notes: str(f, "notes") || null,
            }),
            onClose,
          )
        }
      >
        <Field label="Name" htmlFor="fin-name" className="sm:col-span-2">
          <Input id="fin-name" name="name" required maxLength={120} defaultValue={line?.name ?? ""} placeholder="e.g. Architect, Excavation, Transfer tax" />
        </Field>
        <Field label="Category" htmlFor="fin-category">
          <Select id="fin-category" name="category" defaultValue={line?.category ?? category}>
            {BUDGET_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <MoneyField name="original" label="Original budget" value={line?.originalCents ?? null} hint="Change orders adjust the revised budget, not this." />
        <Field label="Notes" htmlFor="fin-notes" className="sm:col-span-2">
          <Textarea id="fin-notes" name="notes" rows={2} maxLength={1000} defaultValue={line?.notes ?? ""} />
        </Field>
      </FormDialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Commitments                                                         */
/* ------------------------------------------------------------------ */

type Commitment = Data["commitments"][number];

function Commitments({ projectId, data }: { projectId: string; data: Data }) {
  const [editing, setEditing] = useState<Commitment | "new" | null>(null);
  return (
    <div>
      <Toolbar count={`${data.commitments.length} contract${data.commitments.length === 1 ? "" : "s"} / POs`} canAdd={data.access.canEdit} addLabel="Commitment" onAdd={() => setEditing("new")} />
      {data.commitments.length === 0 ? (
        <p className="text-sm text-muted">No contracts or purchase orders yet.</p>
      ) : (
        <MoneyTable
          head={["Vendor", "Line", "Status", "Contract (with COs)", "Billed", "Remaining"]}
          rows={data.commitments.map((c) => [
            <span key="v">
              {c.vendorName}
              {c.description && <span className="block text-[12px] text-muted">{c.description}</span>}
            </span>,
            <span key="l" className="text-muted">
              {c.lineName ?? "Not coded"}
            </span>,
            c.status,
            c.revisedCents !== c.amountCents ? (
              <span key="a">
                {$(c.revisedCents)}
                <span className="block text-[11px] text-muted">orig. {$(c.amountCents)}</span>
              </span>
            ) : (
              $(c.amountCents)
            ),
            $(c.billedCents),
            $(c.revisedCents - c.billedCents),
          ])}
          onRow={data.access.canEdit ? (i) => setEditing(data.commitments[i]!) : undefined}
        />
      )}
      {editing && <CommitmentDialog projectId={projectId} data={data} c={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CommitmentDialog({ projectId, data, c, onClose }: { projectId: string; data: Data; c: Commitment | null; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const invalidate = useInvalidate(projectId);
  const save = useMutation(trpc.financials.saveCommitment.mutationOptions({ onSettled: invalidate }));
  const del = useMutation(trpc.financials.deleteCommitment.mutationOptions({ onSuccess: onClose, onError: (e) => toast("error", errorMessage(e)), onSettled: invalidate }));
  const { error, run } = useSaver(save.mutate);
  const [fileId, setFileId] = useState<string | null>(c?.fileId ?? null);
  return (
    <FormDialog
      title={c ? `${c.vendorName} commitment` : "New commitment"}
      onClose={onClose}
      busy={save.isPending}
      error={error}
      onDelete={c ? () => del.mutate({ projectId, id: c.id, version: c.version }) : undefined}
      deleteLabel="Delete commitment"
      onSubmit={(f) =>
        run(
          () => ({
            projectId,
            id: c?.id,
            version: c?.version,
            vendorName: str(f, "vendor"),
            description: str(f, "desc") || null,
            budgetLineId: str(f, "budgetLineId") || null,
            amountCents: optionalMoney(str(f, "amount"), "amount", "Amount") ?? 0,
            status: str(f, "status") as "draft" | "executed" | "closed",
            signedOn: str(f, "signed") || null,
            retainageBps: optionalPercentBps(str(f, "ret"), "ret", "Retainage") ?? 0,
            fileId,
          }),
          onClose,
        )
      }
    >
      <Field label="Vendor" htmlFor="fin-vendor">
        <Input id="fin-vendor" name="vendor" required maxLength={160} defaultValue={c?.vendorName ?? ""} />
      </Field>
      <LineSelect data={data} value={c?.budgetLineId} />
      <Field label="Description" htmlFor="fin-desc" className="sm:col-span-2">
        <Input id="fin-desc" name="desc" maxLength={1000} defaultValue={c?.description ?? ""} placeholder="e.g. Foundation and superstructure" />
      </Field>
      <MoneyField name="amount" label="Contract amount" value={c?.amountCents ?? null} required />
      <Field label="Status" htmlFor="fin-status">
        <Select id="fin-status" name="status" defaultValue={c?.status ?? "executed"}>
          <option value="draft">Draft (not counted)</option>
          <option value="executed">Executed</option>
          <option value="closed">Closed out</option>
        </Select>
      </Field>
      <Field label="Signed" htmlFor="fin-signed">
        <Input id="fin-signed" name="signed" type="date" defaultValue={c?.signedOn ?? ""} className="num" />
      </Field>
      <Field label="Retainage %" htmlFor="fin-ret" hint="Held back on each invoice under this contract.">
        <Input id="fin-ret" name="ret" inputMode="decimal" defaultValue={c ? String(c.retainageBps / 100) : "10"} className="num" />
      </Field>
      <PdfField projectId={projectId} value={fileId} onChange={setFileId} />
    </FormDialog>
  );
}

function Toolbar({ count, canAdd, addLabel, onAdd, extra }: { count: string; canAdd: boolean; addLabel: string; onAdd: () => void; extra?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <p className="text-[13px] text-muted">{count}</p>
      <div className="flex flex-wrap gap-2">
        {extra}
        {canAdd && (
          <Button variant="secondary" size="sm" onClick={onAdd}>
            <IconPlus size={16} /> {addLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Invoices                                                            */
/* ------------------------------------------------------------------ */

type Invoice = Data["invoices"][number];
const INVOICE_TONE: Record<string, Tone> = { received: "attention", approved: "accent", rejected: "blocked", paid: "done" };
const INVOICE_LABEL: Record<string, string> = { received: "To approve", approved: "Approved", rejected: "Rejected", paid: "Paid" };

function Invoices({ projectId, data }: { projectId: string; data: Data }) {
  const [editing, setEditing] = useState<Invoice | "new" | null>(null);
  const [filter, setFilter] = useState<"all" | "received" | "approved" | "paid" | "rejected">("all");
  const shown = data.invoices.filter((i) => filter === "all" || i.status === filter);
  return (
    <div>
      <Toolbar
        count={`${data.invoices.filter((i) => i.status === "received").length} waiting for approval`}
        canAdd={data.access.canEdit}
        addLabel="Invoice"
        onAdd={() => setEditing("new")}
        extra={
          <Select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="h-9 w-auto text-[13px]">
            <option value="all">All invoices</option>
            <option value="received">To approve</option>
            <option value="approved">Approved, unpaid</option>
            <option value="paid">Paid</option>
            <option value="rejected">Rejected</option>
          </Select>
        }
      />
      {shown.length === 0 ? (
        <p className="text-sm text-muted">No invoices here.</p>
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-surface">
          {shown.map((i) => (
            <li key={i.id}>
              <button type="button" onClick={() => setEditing(i)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-sunken/60">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px]">
                    {i.vendorName}
                    {i.number ? <span className="text-muted"> · #{i.number}</span> : null}
                  </span>
                  <span className="block truncate text-[12px] text-muted">
                    {d(i.invoiceDate)} · {i.lineName ?? "Not coded"}
                    {i.fileId ? " · PDF" : ""}
                  </span>
                </span>
                <span className="num text-[15px] font-medium">{$(i.amountCents, false)}</span>
                <StatusPill tone={INVOICE_TONE[i.status]!}>{INVOICE_LABEL[i.status]}</StatusPill>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <InvoiceDialog projectId={projectId} data={data} inv={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function InvoiceDialog({ projectId, data, inv, onClose }: { projectId: string; data: Data; inv: Invoice | null; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const invalidate = useInvalidate(projectId);
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const save = useMutation(trpc.financials.saveInvoice.mutationOptions({ onSettled: invalidate }));
  const decide = useMutation(trpc.financials.decideInvoice.mutationOptions({ onSuccess: onClose, onError, onSettled: invalidate }));
  const paid = useMutation(trpc.financials.markPaid.mutationOptions({ onSuccess: onClose, onError, onSettled: invalidate }));
  const reopen = useMutation(trpc.financials.reopenInvoice.mutationOptions({ onSuccess: onClose, onError, onSettled: invalidate }));
  const del = useMutation(trpc.financials.deleteInvoice.mutationOptions({ onSuccess: onClose, onError, onSettled: invalidate }));
  const { error, run } = useSaver(save.mutate);
  const [fileId, setFileId] = useState<string | null>(inv?.fileId ?? null);
  const [rejecting, setRejecting] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reopenNote, setReopenNote] = useState("");
  // Existing invoices open read-only: decisions act on what's saved, never on unsaved edits.
  const [mode, setMode] = useState<"view" | "edit">(inv ? "view" : "edit");
  const locked = !!inv && (inv.status === "approved" || inv.status === "paid");
  const editable = data.access.canEdit && !locked;
  const drawStatus = inv?.drawId ? data.draws.find((x) => x.id === inv.drawId)?.status : undefined;
  const onSubmittedDraw = !!drawStatus && drawStatus !== "draft";

  if (inv && mode === "view") {
    return (
      <Dialog open onClose={onClose} title={`${inv.vendorName}${inv.number ? ` #${inv.number}` : ""}`} description={`${$(inv.amountCents, false)} · ${INVOICE_LABEL[inv.status]}`}>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <Fact k="Budget line" v={inv.lineName ?? "Not coded"} />
          <Fact k="Invoice date" v={d(inv.invoiceDate)} />
          <Fact k="Retainage" v={formatBasisPoints(inv.retainageBps, 0)} />
          <Fact k="Paid on" v={d(inv.paidOn)} />
          {inv.drawId && <Fact k="Draw" v={`#${data.draws.find((x) => x.id === inv.drawId)?.number ?? "?"}`} />}
          {inv.decisionNote && <Fact k="Note" v={inv.decisionNote} />}
        </dl>
        {inv.fileId && (
          <div className="mt-4">
            <PdfField projectId={projectId} value={inv.fileId} onChange={() => undefined} readOnly />
          </div>
        )}
        {reopening ? (
          <div className="mt-6 flex flex-col gap-2">
            <label htmlFor="fin-reopen" className="text-[13px] font-medium">
              Why reopen it?
            </label>
            <Textarea id="fin-reopen" rows={2} value={reopenNote} onChange={(e) => setReopenNote(e.target.value)} maxLength={1000} autoFocus />
            <div className="flex gap-2">
              <Button size="sm" disabled={!reopenNote.trim()} loading={reopen.isPending} onClick={() => reopen.mutate({ projectId, id: inv.id, version: inv.version, note: reopenNote.trim() })}>
                Reopen for correction
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setReopening(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-6 flex flex-wrap gap-2">
            {inv.status === "received" && data.access.canApprove && (
              <DecisionButtons busy={decide.isPending} rejecting={rejecting} setRejecting={setRejecting} onDecide={(decision, note) => decide.mutate({ projectId, id: inv.id, version: inv.version, decision, note })} />
            )}
            {!rejecting && editable && (
              <Button variant="secondary" onClick={() => setMode("edit")}>
                Edit
              </Button>
            )}
            {!rejecting && data.access.canEdit && inv.status === "approved" && (
              <Button loading={paid.isPending} onClick={() => paid.mutate({ projectId, id: inv.id, version: inv.version, paidOn: todayET() })}>
                Mark paid today
              </Button>
            )}
            {!rejecting && data.access.canEdit && inv.status === "paid" && !onSubmittedDraw && (
              <Button variant="ghost" loading={paid.isPending} onClick={() => paid.mutate({ projectId, id: inv.id, version: inv.version, paidOn: null })}>
                Undo paid
              </Button>
            )}
            {!rejecting && locked && data.access.canApprove && !onSubmittedDraw && (
              <Button variant="ghost" onClick={() => setReopening(true)}>
                Reopen for correction
              </Button>
            )}
          </div>
        )}
      </Dialog>
    );
  }

  return (
    <FormDialog
      title={inv ? `Edit ${inv.vendorName} invoice` : "Log an invoice"}
      onClose={onClose}
      busy={save.isPending}
      error={error}
      onDelete={inv && !inv.drawId ? () => del.mutate({ projectId, id: inv.id, version: inv.version }) : undefined}
      deleteLabel="Delete invoice"
      onSubmit={(f) =>
        run(
          () => ({
            projectId,
            id: inv?.id,
            version: inv?.version,
            vendorName: str(f, "vendor"),
            number: str(f, "number") || null,
            invoiceDate: str(f, "date") || null,
            amountCents: optionalMoney(str(f, "amount"), "amount", "Amount") ?? 0,
            budgetLineId: str(f, "budgetLineId") || null,
            commitmentId: str(f, "commitmentId") || null,
            retainageBps: optionalPercentBps(str(f, "ret"), "ret", "Retainage") ?? undefined,
            note: str(f, "note") || null,
            fileId,
          }),
          onClose,
        )
      }
    >
      {inv?.status === "rejected" && <p className="rounded-panel bg-sunken px-3 py-2 text-[13px] sm:col-span-2">Rejected: {inv.decisionNote}. Saving sends it back for approval.</p>}
      <Field label="Vendor" htmlFor="fin-vendor">
        <Input id="fin-vendor" name="vendor" required maxLength={160} defaultValue={inv?.vendorName ?? ""} list="fin-vendors" />
        <datalist id="fin-vendors">
          {[...new Set(data.commitments.map((c) => c.vendorName))].map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </Field>
      <Field label="Invoice #" htmlFor="fin-number">
        <Input id="fin-number" name="number" maxLength={60} defaultValue={inv?.number ?? ""} />
      </Field>
      <MoneyField name="amount" label="Amount" value={inv?.amountCents ?? null} required />
      <Field label="Invoice date" htmlFor="fin-date">
        <Input id="fin-date" name="date" type="date" defaultValue={inv?.invoiceDate ?? todayET()} className="num" />
      </Field>
      <Field label="Against contract" htmlFor="fin-commitmentId" hint="Takes the contract's budget line and retainage.">
        <Select id="fin-commitmentId" name="commitmentId" defaultValue={inv?.commitmentId ?? ""}>
          <option value="">None</option>
          {data.commitments.map((c) => (
            <option key={c.id} value={c.id}>
              {c.vendorName} · {$(c.revisedCents)}
            </option>
          ))}
        </Select>
      </Field>
      <LineSelect data={data} value={inv?.budgetLineId} />
      <Field label="Retainage %" htmlFor="fin-ret" hint="Blank uses the contract's.">
        <Input id="fin-ret" name="ret" inputMode="decimal" defaultValue={inv && inv.retainageBps ? String(inv.retainageBps / 100) : ""} className="num" />
      </Field>
      <Field label="Note" htmlFor="fin-note">
        <Input id="fin-note" name="note" maxLength={1000} defaultValue={inv?.note ?? ""} />
      </Field>
      <PdfField projectId={projectId} value={fileId} onChange={setFileId} />
    </FormDialog>
  );
}

function Fact({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-muted">{k}</dt>
      <dd className="num mt-0.5 break-words">{v}</dd>
    </div>
  );
}

function DecisionButtons({ busy, rejecting, setRejecting, onDecide }: { busy: boolean; rejecting: boolean; setRejecting: (b: boolean) => void; onDecide: (d: "approved" | "rejected", note?: string) => void }) {
  const [note, setNote] = useState("");
  if (rejecting) {
    return (
      <div className="flex w-full flex-col gap-2">
        <label htmlFor="fin-reject" className="text-[13px] font-medium">
          Why is it rejected?
        </label>
        <Textarea id="fin-reject" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} autoFocus />
        <div className="flex gap-2">
          <Button size="sm" disabled={!note.trim()} loading={busy} onClick={() => onDecide("rejected", note.trim())}>
            Reject
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <>
      <Button loading={busy} onClick={() => onDecide("approved")}>
        Approve
      </Button>
      <Button variant="secondary" onClick={() => setRejecting(true)}>
        Reject
      </Button>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Change orders                                                       */
/* ------------------------------------------------------------------ */

type ChangeOrder = Data["changeOrders"][number];
const CO_TONE: Record<string, Tone> = { pending: "attention", approved: "done", rejected: "blocked" };

function ChangeOrders({ projectId, data }: { projectId: string; data: Data }) {
  const [editing, setEditing] = useState<ChangeOrder | "new" | null>(null);
  const approved = data.changeOrders.filter((c) => c.status === "approved");
  return (
    <div>
      <Toolbar
        count={`${approved.length} approved · net ${$(sum(approved.map((c) => c.amountCents)))} · ${approved.reduce((n, c) => n + c.scheduleDays, 0)} days`}
        canAdd={data.access.canEdit}
        addLabel="Change order"
        onAdd={() => setEditing("new")}
      />
      {data.changeOrders.length === 0 ? (
        <p className="text-sm text-muted">No change orders.</p>
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-surface">
          {data.changeOrders.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setEditing(c)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-sunken/60">
                <span className="num w-10 shrink-0 text-[13px] text-muted">#{c.number}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px]">{c.description}</span>
                  <span className="block truncate text-[12px] text-muted">
                    {c.lineName ?? "Not coded"}
                    {c.scheduleDays ? ` · ${c.scheduleDays > 0 ? "+" : ""}${c.scheduleDays} days` : ""}
                  </span>
                </span>
                <span className={cn("num text-[15px] font-medium", c.amountCents < 0 && "text-done-text")}>{$(c.amountCents)}</span>
                <StatusPill tone={CO_TONE[c.status]!}>{c.status === "pending" ? "To approve" : c.status === "approved" ? "Approved" : "Rejected"}</StatusPill>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <ChangeOrderDialog projectId={projectId} data={data} co={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ChangeOrderDialog({ projectId, data, co, onClose }: { projectId: string; data: Data; co: ChangeOrder | null; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const invalidate = useInvalidate(projectId);
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const save = useMutation(trpc.financials.saveChangeOrder.mutationOptions({ onSettled: invalidate }));
  const decide = useMutation(trpc.financials.decideChangeOrder.mutationOptions({ onSuccess: onClose, onError, onSettled: invalidate }));
  const del = useMutation(trpc.financials.deleteChangeOrder.mutationOptions({ onSuccess: onClose, onError, onSettled: invalidate }));
  const { error, run } = useSaver(save.mutate);
  const [fileId, setFileId] = useState<string | null>(co?.fileId ?? null);
  const [rejecting, setRejecting] = useState(false);
  const [mode, setMode] = useState<"view" | "edit">(co ? "view" : "edit");
  const editable = data.access.canEdit && co?.status !== "approved";
  if (co && mode === "view") {
    return (
      <Dialog open onClose={onClose} title={`CO #${co.number}`} description={`${$(co.amountCents)} · ${co.status === "pending" ? "to approve" : co.status}`}>
        <p className="text-[15px]">{co.description}</p>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <Fact k="Budget line" v={co.lineName ?? "Not coded"} />
          <Fact k="Schedule impact" v={`${co.scheduleDays} days`} />
          {co.decisionNote && <Fact k="Note" v={co.decisionNote} />}
        </dl>
        {co.fileId && (
          <div className="mt-4">
            <PdfField projectId={projectId} value={co.fileId} onChange={() => undefined} readOnly />
          </div>
        )}
        <div className="mt-6 flex flex-wrap gap-2">
          {co.status === "pending" && data.access.canApprove && (
            <DecisionButtons busy={decide.isPending} rejecting={rejecting} setRejecting={setRejecting} onDecide={(decision, note) => decide.mutate({ projectId, id: co.id, version: co.version, decision, note })} />
          )}
          {!rejecting && editable && (
            <Button variant="secondary" onClick={() => setMode("edit")}>
              Edit
            </Button>
          )}
        </div>
      </Dialog>
    );
  }
  return (
    <FormDialog
      title={co ? `Edit CO #${co.number}` : "New change order"}
      onClose={onClose}
      busy={save.isPending}
      error={error}
      onDelete={co ? () => del.mutate({ projectId, id: co.id, version: co.version }) : undefined}
      deleteLabel="Delete change order"
      onSubmit={(f) =>
        run(
          () => ({
            projectId,
            id: co?.id,
            version: co?.version,
            description: str(f, "desc"),
            amountCents: optionalSignedMoney(str(f, "amount"), "amount", "Amount") ?? 0,
            scheduleDays: optionalSignedInt(str(f, "days")),
            budgetLineId: str(f, "budgetLineId") || null,
            commitmentId: str(f, "commitmentId") || null,
            fileId,
          }),
          onClose,
        )
      }
    >
      {co?.status === "rejected" && <p className="rounded-panel bg-sunken px-3 py-2 text-[13px] sm:col-span-2">Rejected: {co.decisionNote}. Saving sends it back for approval.</p>}
      <Field label="What changed" htmlFor="fin-desc" className="sm:col-span-2">
        <Textarea id="fin-desc" name="desc" rows={2} required maxLength={1000} defaultValue={co?.description ?? ""} />
      </Field>
      <MoneyField name="amount" label="Amount" value={co?.amountCents ?? null} required hint="Negative for a credit." />
      <Field label="Schedule impact (days)" htmlFor="fin-days">
        <Input id="fin-days" name="days" inputMode="numeric" defaultValue={String(co?.scheduleDays ?? 0)} className="num" />
      </Field>
      <Field label="Contract" htmlFor="fin-commitmentId" hint="A change to a contract also changes what's committed.">
        <Select id="fin-commitmentId" name="commitmentId" defaultValue={co?.commitmentId ?? ""}>
          <option value="">None</option>
          {data.commitments.map((c) => (
            <option key={c.id} value={c.id}>
              {c.vendorName}
            </option>
          ))}
        </Select>
      </Field>
      <LineSelect data={data} value={co?.budgetLineId} />
      <PdfField projectId={projectId} value={fileId} onChange={setFileId} />
    </FormDialog>
  );
}

function optionalSignedInt(raw: string): number {
  const s = raw.trim();
  if (!s) return 0;
  if (!/^-?\d+$/.test(s)) throw new FieldError("days", "Schedule impact must be a whole number of days.");
  return Number(s);
}

/* ------------------------------------------------------------------ */
/* Draws                                                               */
/* ------------------------------------------------------------------ */

type Draw = Data["draws"][number];
const DRAW_TONE: Record<DrawStatus, Tone> = { draft: "neutral", submitted: "attention", inspector_approved: "accent", funded: "done" };

function Draws({ projectId, data }: { projectId: string; data: Data }) {
  const trpc = useTRPC();
  const toast = useToast();
  const invalidate = useInvalidate(projectId);
  const [open, setOpen] = useState<string | null>(data.draws.find((x) => x.status !== "funded")?.id ?? null);
  const create = useMutation(trpc.financials.createDraw.mutationOptions({ onSuccess: (r) => setOpen(r.id), onError: (e) => toast("error", errorMessage(e)), onSettled: invalidate }));
  const hasDraft = data.draws.some((x) => x.status === "draft");
  return (
    <div>
      <Toolbar count={`${data.draws.length} draw${data.draws.length === 1 ? "" : "s"} · funded ${$(sum(data.draws.filter((x) => x.status === "funded").map((x) => x.fundedCents ?? x.totals.net)))} · retainage held ${$(data.retainageHeldCents)}`} canAdd={data.access.canEdit && !hasDraft} addLabel="New draw" onAdd={() => create.mutate({ projectId })} />
      {data.draws.length === 0 ? (
        <p className="text-sm text-muted">No draws yet. A draw requisitions approved invoices, holds back retainage, and tracks lien waivers and the lender inspector.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {[...data.draws].reverse().map((dr) => (
            <li key={dr.id} className="rounded-card border border-border bg-surface">
              <button type="button" onClick={() => setOpen(open === dr.id ? null : dr.id)} aria-expanded={open === dr.id} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left">
                <span className="text-[15px] font-medium">Draw #{dr.number}</span>
                <span className="num text-[13px] text-muted">{d(dr.periodEnd)}</span>
                <span className="num ml-auto text-[15px] font-medium">{$(dr.totals.net)}</span>
                <StatusPill tone={DRAW_TONE[dr.status]}>{DRAW_STATUS_LABEL[dr.status]}</StatusPill>
              </button>
              {open === dr.id && <DrawEditor projectId={projectId} data={data} draw={dr} />}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function DrawEditor({ projectId, data, draw }: { projectId: string; data: Data; draw: Draw }) {
  const trpc = useTRPC();
  const toast = useToast();
  const invalidate = useInvalidate(projectId);
  const onError = (e: unknown) => toast("error", errorMessage(e));
  // The newest version we know of: the server's answer arrives before the refetch does.
  const [seen, setSeen] = useState(0);
  const update = useMutation(trpc.financials.updateDraw.mutationOptions({ onSuccess: (r) => setSeen((v) => Math.max(v, r.version)), onError, onSettled: invalidate }));
  const advance = useMutation(trpc.financials.advanceDraw.mutationOptions({ onSuccess: (r) => toast("success", DRAW_STATUS_LABEL[r.status as DrawStatus]), onError, onSettled: invalidate }));
  const del = useMutation(trpc.financials.deleteDraw.mutationOptions({ onError, onSettled: invalidate }));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const edit = data.access.canEdit;
  const draft = draw.status === "draft";
  const inspectorLocked = draw.status === "inspector_approved" || draw.status === "funded";
  const eligible = data.invoices.filter((i) => (i.status === "approved" || i.status === "paid") && (!i.drawId || i.drawId === draw.id));
  // Show a tick at once; the draw refreshes (and re-syncs) when the server answers.
  const version = Math.max(draw.version, seen);
  const [local, setLocal] = useState<{ version: number; ids: string[]; waivers: typeof draw.lienWaivers } | null>(null);
  const cur = local && local.version > draw.version ? local : null;
  const on = new Set(cur?.ids ?? draw.invoiceIds);
  const waivers = cur?.waivers ?? draw.lienWaivers;
  const setInvoices = (ids: string[]) => {
    setLocal({ version: version + 1, ids, waivers });
    update.mutate({ projectId, id: draw.id, version, invoiceIds: ids }, { onError: () => setLocal(null) });
  };
  const setWaiver = (idx: number, received: boolean) => {
    const next = waivers.map((x, j) => (j === idx ? { ...x, received } : x));
    setLocal({ version: version + 1, ids: [...on], waivers: next });
    update.mutate({ projectId, id: draw.id, version, lienWaivers: next }, { onError: () => setLocal(null) });
  };
  const next = draw.status === "draft" ? "Submit to lender" : draw.status === "submitted" ? "Inspector signed off" : draw.status === "inspector_approved" ? "Mark funded" : null;
  return (
    <div className="flex flex-col gap-5 border-t border-border px-4 py-4">
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <Fact k="Gross" v={$(draw.totals.gross, false)} />
        <Fact k="Retainage held" v={$(draw.totals.retainage, false)} />
        <Fact k="Net requested" v={$(draw.totals.net, false)} />
      </dl>
      <section>
        <h4 className="mb-2 text-[13px] font-medium">Invoices on this draw</h4>
        {eligible.length === 0 ? (
          <p className="text-[13px] text-muted">No approved invoices available.</p>
        ) : (
          <ul className="divide-y divide-border rounded-panel border border-border">
            {eligible.map((i) => (
              <li key={i.id}>
                <label className={cn("flex min-h-11 items-center gap-3 px-3 py-2 text-sm", draft && edit && "cursor-pointer")}>
                  <input type="checkbox" disabled={!draft || !edit || update.isPending} checked={on.has(i.id)} onChange={(e) => setInvoices(e.target.checked ? [...on, i.id] : [...on].filter((x) => x !== i.id))} className="size-4 accent-[var(--accent)]" />
                  <span className="min-w-0 flex-1 truncate">
                    {i.vendorName}
                    {i.number ? ` #${i.number}` : ""}
                  </span>
                  <span className="num shrink-0">{$(i.amountCents, false)}</span>
                  {i.retainageBps > 0 && <span className="num shrink-0 text-[12px] text-muted">{formatBasisPoints(i.retainageBps, 0)} ret.</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h4 className="mb-2 text-[13px] font-medium">Lien waivers</h4>
        {waivers.length === 0 ? (
          <p className="text-[13px] text-muted">One per vendor on the draw.</p>
        ) : (
          <ul className="flex flex-col">
            {waivers.map((w, idx) => (
              <li key={w.vendor}>
                <label className="flex min-h-10 items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    disabled={!edit || !draft || update.isPending}
                    checked={w.received}
                    onChange={(e) => setWaiver(idx, e.target.checked)}
                    className="size-4 accent-[var(--accent)]"
                  />
                  {w.vendor}
                  <span className={cn("text-[12px]", w.received ? "text-done-text" : "text-muted")}>{w.received ? "received" : "outstanding"}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>
      {edit && (
        <form
          className="grid gap-4 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const advancing = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("data-advance") === "1";
            let funded: number | null | undefined;
            try {
              funded = draft ? undefined : optionalMoney(str(f, "funded"), "funded", "Funded amount");
            } catch (err) {
              toast("error", (err as Error).message);
              return;
            }
            // Save what's typed first, then (for the next-step button) move the draw along with the new version.
            update.mutate(
              {
                projectId,
                id: draw.id,
                version,
                ...(inspectorLocked ? {} : { inspectorName: str(f, "insp") || null, inspectorSignedOn: str(f, "inspOn") || null }),
                ...(draft ? { periodEnd: str(f, "period") || null } : {}),
                ...(funded !== undefined ? { fundedCents: funded } : {}),
              },
              { onSuccess: (r) => (advancing ? advance.mutate({ projectId, id: draw.id, version: r.version }) : toast("success", "Draw saved")) },
            );
          }}
        >
          <Field label="Period ending" htmlFor={`dr-period-${draw.id}`}>
            <Input id={`dr-period-${draw.id}`} name="period" type="date" disabled={!draft} defaultValue={draw.periodEnd ?? ""} className="num" />
          </Field>
          <Field label="Lender inspector" htmlFor={`dr-insp-${draw.id}`}>
            <Input id={`dr-insp-${draw.id}`} name="insp" maxLength={160} disabled={inspectorLocked} defaultValue={draw.inspectorName ?? ""} />
          </Field>
          <Field label="Inspector signed off" htmlFor={`dr-insp-on-${draw.id}`}>
            <Input id={`dr-insp-on-${draw.id}`} name="inspOn" type="date" disabled={inspectorLocked} defaultValue={draw.inspectorSignedOn ?? ""} className="num" />
          </Field>
          {!draft && <MoneyField name="funded" label="Amount funded" value={draw.fundedCents} />}
          <div className="flex flex-wrap items-end gap-2 sm:col-span-3">
            <Button type="submit" variant="secondary" size="sm" loading={update.isPending && !advance.isPending}>
              Save
            </Button>
            {next && (
              <Button type="submit" data-advance="1" size="sm" loading={advance.isPending} disabled={update.isPending}>
                {next}
              </Button>
            )}
            {draft && (
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setConfirmDelete(true)}>
                Delete draft
              </Button>
            )}
          </div>
        </form>
      )}
      <ConfirmDialog open={confirmDelete} title={`Delete draft draw #${draw.number}?`} body="Its invoices go back to being available. The draw number isn't reused." confirmLabel="Delete draft" danger busy={del.isPending} onCancel={() => setConfirmDelete(false)} onConfirm={() => del.mutate({ projectId, id: draw.id, version }, { onSuccess: () => setConfirmDelete(false) })} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sales                                                               */
/* ------------------------------------------------------------------ */

type Unit = Data["units"][number];
const UNIT_TONE: Record<UnitStatus, Tone> = { available: "neutral", reserved: "attention", contract: "accent", closed: "done" };

function Sales({ projectId, data }: { projectId: string; data: Data }) {
  const [editing, setEditing] = useState<Unit | "new" | null>(null);
  const s = data.sales;
  return (
    <div>
      {s && (
        <dl className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-card border border-border bg-surface p-4">
            <dt className="text-[12px] text-muted">Projected sellout</dt>
            <dd className="num mt-1 text-[17px] font-medium">{$(s.projectedSellout)}</dd>
          </div>
          <div className="rounded-card border border-border bg-surface p-4">
            <dt className="text-[12px] text-muted">Closed</dt>
            <dd className="num mt-1 text-[17px] font-medium">
              {s.sold} · {$(s.closedCents)}
            </dd>
          </div>
          <div className="rounded-card border border-border bg-surface p-4">
            <dt className="text-[12px] text-muted">In contract</dt>
            <dd className="num mt-1 text-[17px] font-medium">
              {s.inContract} · {$(s.contractCents)}
            </dd>
          </div>
          <div className="rounded-card border border-border bg-surface p-4">
            <dt className="text-[12px] text-muted">Units</dt>
            <dd className="num mt-1 text-[17px] font-medium">{s.units}</dd>
          </div>
        </dl>
      )}
      <Toolbar count={s ? `${s.units - s.sold - s.inContract} still to sell` : "No units yet"} canAdd={data.access.canEdit} addLabel="Unit" onAdd={() => setEditing("new")} />
      {data.units.length > 0 && (
        <MoneyTable
          head={["Unit", "SF", "Beds / baths", "Ask", "Ask $/sf", "Contract", "Contract $/sf", "Status", "Closing"]}
          rows={data.units.map((u) => [
            u.unit,
            u.sf?.toLocaleString("en-US") ?? "—",
            u.beds != null || u.baths != null ? `${u.beds ?? "—"} / ${u.baths ?? "—"}` : "—",
            $(u.askCents),
            $(u.askPerSf),
            $(u.contractCents),
            $(u.contractPerSf),
            <StatusPill key="s" tone={UNIT_TONE[u.status]}>
              {UNIT_STATUS_LABEL[u.status]}
            </StatusPill>,
            d(u.closingOn),
          ])}
          onRow={data.access.canEdit ? (i) => setEditing(data.units[i]!) : undefined}
        />
      )}
      {editing && <UnitDialog projectId={projectId} unit={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function UnitDialog({ projectId, unit: u, onClose }: { projectId: string; unit: Unit | null; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const invalidate = useInvalidate(projectId);
  const save = useMutation(trpc.financials.saveUnit.mutationOptions({ onSettled: invalidate }));
  const del = useMutation(trpc.financials.deleteUnit.mutationOptions({ onSuccess: onClose, onError: (e) => toast("error", errorMessage(e)), onSettled: invalidate }));
  const { error, run } = useSaver(save.mutate);
  const half = (raw: string, label: string) => {
    if (!raw) return null;
    if (!/^\d+(\.5)?$/.test(raw)) throw new FieldError(label, `${label} must be a whole or half number.`);
    return Number(raw);
  };
  return (
    <FormDialog
      title={u ? `Unit ${u.unit}` : "New unit"}
      onClose={onClose}
      busy={save.isPending}
      error={error}
      onDelete={u ? () => del.mutate({ projectId, id: u.id, version: u.version }) : undefined}
      deleteLabel="Delete unit"
      onSubmit={(f) =>
        run(
          () => ({
            projectId,
            id: u?.id,
            version: u?.version,
            unit: str(f, "unit"),
            floor: str(f, "floor") || null,
            sf: optionalInt(str(f, "sf"), "sf", "Square feet", 1_000_000),
            beds: half(str(f, "beds"), "Beds"),
            baths: half(str(f, "baths"), "Baths"),
            askCents: optionalMoney(str(f, "ask"), "ask", "Ask"),
            contractCents: optionalMoney(str(f, "contract"), "contract", "Contract price"),
            status: str(f, "status") as UnitStatus,
            buyerName: str(f, "buyer") || null,
            contractOn: str(f, "contractOn") || null,
            closingOn: str(f, "closingOn") || null,
          }),
          onClose,
        )
      }
    >
      <Field label="Unit" htmlFor="fin-unit">
        <Input id="fin-unit" name="unit" required maxLength={40} defaultValue={u?.unit ?? ""} placeholder="e.g. 3A, PH" />
      </Field>
      <Field label="Floor" htmlFor="fin-floor">
        <Input id="fin-floor" name="floor" maxLength={20} defaultValue={u?.floor ?? ""} />
      </Field>
      <Field label="Square feet" htmlFor="fin-sf">
        <Input id="fin-sf" name="sf" inputMode="numeric" defaultValue={u?.sf?.toString() ?? ""} className="num" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Beds" htmlFor="fin-beds">
          <Input id="fin-beds" name="beds" inputMode="decimal" defaultValue={u?.beds?.toString() ?? ""} className="num" />
        </Field>
        <Field label="Baths" htmlFor="fin-baths">
          <Input id="fin-baths" name="baths" inputMode="decimal" defaultValue={u?.baths?.toString() ?? ""} className="num" />
        </Field>
      </div>
      <MoneyField name="ask" label="Asking price" value={u?.askCents ?? null} />
      <MoneyField name="contract" label="Contract price" value={u?.contractCents ?? null} hint="Required once in contract." />
      <Field label="Status" htmlFor="fin-ustatus">
        <Select id="fin-ustatus" name="status" defaultValue={u?.status ?? "available"}>
          {UNIT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {UNIT_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Buyer" htmlFor="fin-buyer">
        <Input id="fin-buyer" name="buyer" maxLength={160} defaultValue={u?.buyerName ?? ""} />
      </Field>
      <Field label="Contract signed" htmlFor="fin-contractOn">
        <Input id="fin-contractOn" name="contractOn" type="date" defaultValue={u?.contractOn ?? ""} className="num" />
      </Field>
      <Field label="Closing" htmlFor="fin-closingOn">
        <Input id="fin-closingOn" name="closingOn" type="date" defaultValue={u?.closingOn ?? ""} className="num" />
      </Field>
    </FormDialog>
  );
}
