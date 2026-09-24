"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconArrowDown, IconArrowUp, IconClose, IconPlus } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Badge, Button, Field, Input, Select, Skeleton, StatusPill, Textarea } from "@/components/ui/primitives";
import { centsToInput, FieldError, optionalMoney } from "@/core/forms";
import { formatMoney } from "@/core/money";
import { formatIsoDate, todayET } from "@/core/time";
import { quarterBounds, quarterOf, tierProblems, type Tier } from "@/core/waterfall";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";

type Data = RouterOutputs["capital"]["overview"];
type Account = Data["accounts"][number];
type Call = Data["calls"][number];
type CallItem = Call["items"][number];

const $ = (c: number | null | undefined) => (c == null ? "—" : formatMoney(c, { whole: true }));
const d = (iso: string | null | undefined) => (iso ? formatIsoDate(iso, { month: "short", day: "numeric", year: "numeric" }) : "—");
const KIND: Record<string, string> = { equity: "Equity", jv_partner: "JV partner", lender: "Lender" };

/** Module J: investors, commitments, capital calls, distributions and the waterfall for this project. */
export function CapitalSection({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.capital.overview.queryOptions({ projectId }));
  const [dialog, setDialog] = useState<null | { kind: "investor"; account: Account | null } | { kind: "terms" } | { kind: "call" } | { kind: "receipt"; item: CallItem; number: number } | { kind: "distribution" }>(null);
  const [quarter, setQuarter] = useState(quarterOf(todayET(), -1));
  if (q.isPending) return <Skeleton className="h-96 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const data = q.data;
  const quarters = [0, -1, -2, -3, -4].map((o) => quarterOf(todayET(), o));

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <dl className="num grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
          <Stat label="Committed" value={$(data.totals.committed)} />
          <Stat label="Contributed" value={$(data.totals.contributed)} />
          <Stat label="Distributed" value={$(data.totals.distributed)} />
          <Stat label="Sponsor promote" value={$(data.totals.promote)} />
        </dl>
        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-muted">Quarterly report</span>
            <Select value={quarter} onChange={(e) => setQuarter(e.target.value)} className="h-9 text-[13px]">
              {quarters.map((x) => (
                <option key={x} value={x}>
                  {quarterBounds(x)!.label}
                </option>
              ))}
            </Select>
          </label>
          <a href={`/api/export/projects/${projectId}/investor-report?quarter=${quarter}`} className="inline-flex h-9 items-center rounded-control border border-control px-3 text-[13px] font-medium hover:bg-sunken">
            PDF
          </a>
        </div>
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="serif text-[20px]">Waterfall</h3>
          {data.canEdit && (
            <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "terms" })}>
              Edit tiers
            </Button>
          )}
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-[15px]">
          {data.terms.description.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ol>
        {!data.terms.custom && <p className="mt-2 text-[13px] text-muted">The standard terms. Edit them to match the operating agreement.</p>}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="serif text-[20px]">Investors</h3>
          {data.canEdit && (
            <Button size="sm" onClick={() => setDialog({ kind: "investor", account: null })}>
              <IconPlus size={16} /> Add investor
            </Button>
          )}
        </div>
        {data.accounts.length === 0 ? (
          <EmptyState title="No investors yet" body="Add each equity investor, JV partner or lender with their commitment. Calls and distributions are tracked per investor." />
        ) : (
          <div className="overflow-x-auto rounded-card border border-border bg-surface">
            <table className="w-full min-w-[720px] text-[14px]">
              <thead className="border-b border-border text-left text-[12px] text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Investor</th>
                  <th className="px-4 py-2 text-right font-medium">Committed</th>
                  <th className="px-4 py-2 text-right font-medium">Contributed</th>
                  <th className="px-4 py-2 text-right font-medium">Distributed</th>
                  <th className="px-4 py-2 text-right font-medium">Still invested</th>
                  <th className="px-4 py-2 text-right font-medium">Pref owed</th>
                </tr>
              </thead>
              <tbody className="num divide-y divide-border">
                {data.accounts.map((a) => (
                  <tr key={a.investor.id}>
                    <td className="px-4 py-3">
                      <button type="button" disabled={!data.canEdit} onClick={() => setDialog({ kind: "investor", account: a })} className="text-left font-medium">
                        {a.investor.name}
                      </button>
                      <span className="block text-[12px] text-muted">
                        {KIND[a.investor.kind]}
                        {a.investor.userId ? " · portal access" : ""}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">{$(a.account.committed)}</td>
                    <td className="px-4 py-3 text-right">{$(a.account.contributed)}</td>
                    <td className="px-4 py-3 text-right">{$(a.account.distributed)}</td>
                    <td className="px-4 py-3 text-right">{$(a.account.unreturned)}</td>
                    <td className="px-4 py-3 text-right">{a.account.prefOwed == null ? "—" : $(a.account.prefOwed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="serif text-[20px]">Capital calls</h3>
          {data.canEdit && data.accounts.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "call" })}>
              <IconPlus size={16} /> New call
            </Button>
          )}
        </div>
        {data.calls.length === 0 ? (
          <p className="text-[13px] text-muted">No calls yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {data.calls.map((call) => (
              <CallCard key={call.id} projectId={projectId} call={call} canEdit={data.canEdit} onReceipt={(item) => setDialog({ kind: "receipt", item, number: call.number })} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="serif text-[20px]">Distributions</h3>
          {data.canEdit && data.accounts.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "distribution" })}>
              <IconPlus size={16} /> Record distribution
            </Button>
          )}
        </div>
        {data.distributions.length === 0 ? (
          <p className="text-[13px] text-muted">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {data.distributions.map((x, i) => (
              <DistributionCard key={x.id} projectId={projectId} dist={x} latest={i === 0} canEdit={data.canEdit} />
            ))}
          </ul>
        )}
      </section>

      {dialog?.kind === "investor" && <InvestorDialog projectId={projectId} data={data} account={dialog.account} onClose={() => setDialog(null)} />}
      {dialog?.kind === "terms" && <TermsDialog projectId={projectId} data={data} onClose={() => setDialog(null)} />}
      {dialog?.kind === "call" && <CallDialog projectId={projectId} onClose={() => setDialog(null)} />}
      {dialog?.kind === "receipt" && <ReceiptDialog projectId={projectId} item={dialog.item} number={dialog.number} onClose={() => setDialog(null)} />}
      {dialog?.kind === "distribution" && <DistributionDialog projectId={projectId} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="text-[20px] font-medium">{value}</dd>
    </div>
  );
}

function useRefresh(projectId: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: trpc.capital.overview.queryKey({ projectId }) });
}

function CallCard({ projectId, call, canEdit, onReceipt }: { projectId: string; call: Call; canEdit: boolean; onReceipt: (i: CallItem) => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const refresh = useRefresh(projectId);
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation(trpc.capital.deleteCall.mutationOptions({ onSuccess: () => refresh(), onError: (e) => toast("error", errorMessage(e)) }));
  const total = call.items.reduce((a, i) => a + i.amountCents, 0);
  const received = call.items.reduce((a, i) => a + i.receivedCents, 0);
  const late = received < total && call.dueOn < todayET();
  return (
    <li className="rounded-card border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <span>
          <span className="font-medium">Call #{call.number}</span>{" "}
          <span className="num text-[13px] text-muted">
            · {$(total)} · notice {d(call.noticeOn)} · due {d(call.dueOn)}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <StatusPill tone={received >= total ? "done" : late ? "blocked" : "attention"}>{received >= total ? "Fully funded" : `${$(received)} in`}</StatusPill>
          {canEdit && received === 0 && (
            <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
              Withdraw
            </Button>
          )}
        </span>
      </div>
      <ul className="num divide-y divide-border border-t border-border text-[14px]">
        {call.items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2">
            <span>{i.investorName}</span>
            <span className="flex items-center gap-3">
              <span className="text-muted">
                {$(i.receivedCents)} of {$(i.amountCents)}
                {i.receivedOn ? ` · ${d(i.receivedOn)}` : ""}
              </span>
              {canEdit && (
                <Button size="sm" variant="ghost" onClick={() => onReceipt(i)}>
                  Record receipt
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <ConfirmDialog open={confirm} title={`Withdraw call #${call.number}?`} body="Nothing has come in on it. Its number isn't reused." confirmLabel="Withdraw" danger busy={remove.isPending} onCancel={() => setConfirm(false)} onConfirm={() => remove.mutate({ projectId, id: call.id })} />
    </li>
  );
}

function DistributionCard({ projectId, dist, latest, canEdit }: { projectId: string; dist: Data["distributions"][number]; latest: boolean; canEdit: boolean }) {
  const trpc = useTRPC();
  const toast = useToast();
  const refresh = useRefresh(projectId);
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation(trpc.capital.deleteDistribution.mutationOptions({ onSuccess: () => refresh(), onError: (e) => toast("error", errorMessage(e)) }));
  return (
    <li className="rounded-card border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <span>
          <span className="font-medium">Distribution #{dist.number}</span>{" "}
          <span className="num text-[13px] text-muted">
            · {$(dist.totalCents)} · {d(dist.paidOn)}
            {dist.gpCents > 0 ? ` · promote ${$(dist.gpCents)}` : ""}
          </span>
        </span>
        {canEdit && latest && (
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
            Remove
          </Button>
        )}
      </div>
      <ul className="num divide-y divide-border border-t border-border text-[14px]">
        {dist.items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2">
            <span>{i.investorName}</span>
            <span className="text-muted">
              {$(i.rocCents + i.prefCents + i.profitCents)} <span className="text-[12px]">(capital {$(i.rocCents)} · pref {$(i.prefCents)} · profit {$(i.profitCents)})</span>
            </span>
          </li>
        ))}
      </ul>
      <ConfirmDialog open={confirm} title={`Remove distribution #${dist.number}?`} body="Only the latest can be removed, since later ones are split knowing about it." confirmLabel="Remove" danger busy={remove.isPending} onCancel={() => setConfirm(false)} onConfirm={() => remove.mutate({ projectId, id: dist.id })} />
    </li>
  );
}

function InvestorDialog({ projectId, data, account, onClose }: { projectId: string; data: Data; account: Account | null; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const refresh = useRefresh(projectId);
  const [existing, setExisting] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const save = useMutation(
    trpc.capital.saveInvestor.mutationOptions({
      onSuccess: async () => {
        toast("success", account ? "Saved" : "Investor added");
        await refresh();
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );
  const attach = useMutation(
    trpc.capital.setCommitment.mutationOptions({
      onSuccess: async () => {
        toast("success", "Investor added");
        await refresh();
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );
  const remove = useMutation(
    trpc.capital.removeInvestor.mutationOptions({
      onSuccess: async () => {
        await refresh();
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );
  const inv = account?.investor;
  const picked = data.allInvestors.find((x) => x.id === existing);
  const available = data.allInvestors.filter((x) => !data.accounts.some((a) => a.investor.id === x.id));
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    try {
      const committedCents = optionalMoney(s("committed"), "committed", "Commitment") ?? 0;
      // Someone already in another project: just their commitment here; their shared record stays as it is.
      if (picked) return attach.mutate({ projectId, investorId: picked.id, committedCents });
      save.mutate({
        projectId,
        investorId: inv?.id,
        version: inv?.version,
        commitmentVersion: account?.commitmentVersion,
        name: s("name"),
        kind: s("kind") as "equity",
        contactName: s("contactName") || null,
        email: s("email") || null,
        userId: s("userId") || null,
        notes: s("notes") || null,
        committedCents,
      });
    } catch (err) {
      setError(err instanceof FieldError ? err.message : errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={inv ? inv.name : "Add an investor"}
      footer={
        <>
          {account && (
            <Button variant="danger" className="mr-auto" onClick={() => setConfirm(true)}>
              Remove
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="inv-form" loading={save.isPending || attach.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="inv-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {!inv && available.length > 0 && (
          <Field label="Existing investor" htmlFor="inv-existing" className="sm:col-span-2" hint="On other projects already? Pick them; otherwise fill in a new one.">
            <Select id="inv-existing" value={existing} onChange={(e) => setExisting(e.target.value)}>
              <option value="">New investor</option>
              {available.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {!picked && (
          <>
            <Field label="Name" htmlFor="inv-name">
              <Input id="inv-name" name="name" required maxLength={160} defaultValue={inv?.name ?? ""} placeholder="e.g. Harbor Capital LP" />
            </Field>
            <Field label="Kind" htmlFor="inv-kind">
              <Select id="inv-kind" name="kind" defaultValue={inv?.kind ?? "equity"}>
                {Object.entries(KIND).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Contact" htmlFor="inv-contact">
              <Input id="inv-contact" name="contactName" maxLength={160} defaultValue={inv?.contactName ?? ""} />
            </Field>
            <Field label="Email" htmlFor="inv-email">
              <Input id="inv-email" name="email" type="email" maxLength={200} defaultValue={inv?.email ?? ""} />
            </Field>
            <Field label="Portal login" htmlFor="inv-user" className="sm:col-span-2" hint="Invite them on the Team page with the Investor role, add them to this project, then link them here.">
              <Select id="inv-user" name="userId" defaultValue={inv?.userId ?? ""}>
                <option value="">No portal login</option>
                {data.portalUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
        <Field label="Commitment" htmlFor="inv-committed" className="sm:col-span-2">
          <Input id="inv-committed" name="committed" inputMode="decimal" required defaultValue={centsToInput(account?.account.committed)} className="num" />
        </Field>
        {!picked && (
          <Field label="Notes" htmlFor="inv-notes" className="sm:col-span-2">
            <Textarea id="inv-notes" name="notes" rows={2} maxLength={2000} defaultValue={inv?.notes ?? ""} />
          </Field>
        )}
        {error && (
          <p role="alert" className="text-[13px] text-blocked-text sm:col-span-2">
            {error}
          </p>
        )}
      </form>
      <ConfirmDialog open={confirm} title="Remove this investor from the project?" body="Only before any call or distribution. Their record stays for other projects." confirmLabel="Remove" danger busy={remove.isPending} onCancel={() => setConfirm(false)} onConfirm={() => remove.mutate({ projectId, investorId: inv!.id })} />
    </Dialog>
  );
}

type TierDraft = { kind: Tier["kind"]; rate: string; lp: string; until: string };
const toDraft = (t: Tier): TierDraft => ({
  kind: t.kind,
  rate: t.kind === "pref" ? String(t.rateBps / 100) : "8",
  lp: t.kind === "split" ? String(t.lpBps / 100) : "80",
  until: t.kind === "split" && t.untilMultipleMilli !== null ? String(t.untilMultipleMilli / 1000) : "",
});
function fromDraft(x: TierDraft): Tier | null {
  if (x.kind === "return_of_capital") return { kind: "return_of_capital" };
  if (x.kind === "pref") {
    const r = Number(x.rate);
    return Number.isFinite(r) ? { kind: "pref", rateBps: Math.round(r * 100) } : null;
  }
  const lp = Number(x.lp);
  const until = x.until.trim() ? Number(x.until) : null;
  if (!Number.isFinite(lp) || (until !== null && !Number.isFinite(until))) return null;
  return { kind: "split", lpBps: Math.round(lp * 100), untilMultipleMilli: until === null ? null : Math.round(until * 1000) };
}

function TermsDialog({ projectId, data, onClose }: { projectId: string; data: Data; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const refresh = useRefresh(projectId);
  const [rows, setRows] = useState<TierDraft[]>(data.terms.tiers.map(toDraft));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation(
    trpc.capital.saveTerms.mutationOptions({
      onSuccess: async () => {
        toast("success", "Waterfall saved");
        await refresh();
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );
  const tiers = rows.map(fromDraft);
  const problems = tiers.some((t) => t === null) ? ["Enter numbers only."] : tierProblems(tiers as Tier[]);
  const set = (i: number, patch: Partial<TierDraft>) => setRows((r) => r.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const move = (i: number, by: number) => setRows((r) => {
    const n = [...r];
    const [x] = n.splice(i, 1);
    n.splice(i + by, 0, x!);
    return n;
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Distribution waterfall"
      description="Each distribution runs through these tiers in order. The last one takes whatever is left."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={problems.length > 0} onClick={() => save.mutate({ projectId, tiers: tiers as Tier[], version: data.terms.version })}>
            Save
          </Button>
        </>
      }
    >
      <ol className="flex flex-col gap-3">
        {rows.map((x, i) => (
          <li key={i} className="grid grid-cols-[auto_1fr_auto] items-end gap-3 rounded-panel border border-border p-3">
            <span className="num pb-2 text-[13px] text-muted">{i + 1}</span>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Tier" htmlFor={`t-kind-${i}`}>
                <Select id={`t-kind-${i}`} value={x.kind} onChange={(e) => set(i, { kind: e.target.value as TierDraft["kind"] })}>
                  <option value="pref">Preferred return</option>
                  <option value="return_of_capital">Return of capital</option>
                  <option value="split">Split</option>
                </Select>
              </Field>
              {x.kind === "pref" && (
                <Field label="Rate (% a year, simple)" htmlFor={`t-rate-${i}`}>
                  <Input id={`t-rate-${i}`} inputMode="decimal" value={x.rate} onChange={(e) => set(i, { rate: e.target.value })} className="num" />
                </Field>
              )}
              {x.kind === "split" && (
                <>
                  <Field label="Investors' share (%)" htmlFor={`t-lp-${i}`}>
                    <Input id={`t-lp-${i}`} inputMode="decimal" value={x.lp} onChange={(e) => set(i, { lp: e.target.value })} className="num" />
                  </Field>
                  <Field label="Until investors reach (x)" htmlFor={`t-until-${i}`} hint="Blank: no hurdle">
                    <Input id={`t-until-${i}`} inputMode="decimal" value={x.until} onChange={(e) => set(i, { until: e.target.value })} className="num" placeholder="e.g. 1.5" />
                  </Field>
                </>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <Button size="sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <IconArrowUp size={14} />
              </Button>
              <Button size="sm" variant="ghost" aria-label="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                <IconArrowDown size={14} />
              </Button>
              <Button size="sm" variant="ghost" aria-label="Remove tier" disabled={rows.length === 1} onClick={() => setRows((r) => r.filter((_, k) => k !== i))}>
                <IconClose size={14} />
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <Button size="sm" variant="ghost" className="mt-3" onClick={() => setRows((r) => [...r, { kind: "split", rate: "8", lp: "80", until: "" }])}>
        <IconPlus size={16} /> Add a tier
      </Button>
      {(problems.length > 0 || error) && (
        <ul role="alert" className="mt-4 space-y-1 text-[13px] text-attention-text">
          {[...problems, ...(error ? [error] : [])].map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function CallDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const refresh = useRefresh(projectId);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation(
    trpc.capital.createCall.mutationOptions({
      onSuccess: async (r) => {
        toast("success", `Call #${r.number} issued; linked investors are notified`);
        await refresh();
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    try {
      create.mutate({ projectId, noticeOn: s("notice"), dueOn: s("due"), note: s("note") || null, totalCents: optionalMoney(s("total"), "total", "Amount") ?? 0 });
    } catch (err) {
      setError(err instanceof FieldError ? err.message : errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="New capital call"
      description="The amount is split across investors by their commitments."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="call-form" loading={create.isPending}>
            Issue call
          </Button>
        </>
      }
    >
      <form id="call-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount to call" htmlFor="call-total" className="sm:col-span-2">
          <Input id="call-total" name="total" inputMode="decimal" required className="num" />
        </Field>
        <Field label="Notice date" htmlFor="call-notice">
          <Input id="call-notice" name="notice" type="date" required defaultValue={todayET()} className="num" />
        </Field>
        <Field label="Due" htmlFor="call-due">
          <Input id="call-due" name="due" type="date" required className="num" />
        </Field>
        <Field label="Note" htmlFor="call-note" className="sm:col-span-2">
          <Textarea id="call-note" name="note" rows={2} maxLength={1000} placeholder="What it's for, e.g. closing costs" />
        </Field>
        {error && (
          <p role="alert" className="text-[13px] text-blocked-text sm:col-span-2">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function ReceiptDialog({ projectId, item, number, onClose }: { projectId: string; item: CallItem; number: number; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const refresh = useRefresh(projectId);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation(
    trpc.capital.recordReceipt.mutationOptions({
      onSuccess: async () => {
        toast("success", "Receipt recorded");
        await refresh();
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    try {
      save.mutate({ projectId, itemId: item.id, version: item.version, receivedCents: optionalMoney(s("amount"), "amount", "Amount") ?? 0, receivedOn: s("on") || null });
    } catch (err) {
      setError(err instanceof FieldError ? err.message : errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Call #${number}: ${item.investorName}`}
      description={`Called ${$(item.amountCents)}.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="receipt-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="receipt-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Received" htmlFor="rc-amount">
          <Input id="rc-amount" name="amount" inputMode="decimal" defaultValue={centsToInput(item.receivedCents || item.amountCents)} className="num" />
        </Field>
        <Field label="On" htmlFor="rc-on">
          <Input id="rc-on" name="on" type="date" max={todayET()} defaultValue={item.receivedOn ?? todayET()} className="num" />
        </Field>
        {error && (
          <p role="alert" className="text-[13px] text-blocked-text sm:col-span-2">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function DistributionDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const refresh = useRefresh(projectId);
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(todayET());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  let cents: number | null = null;
  try {
    cents = optionalMoney(amount, "amount", "Amount");
  } catch {
    cents = null;
  }
  const preview = useQuery({ ...trpc.capital.previewDistribution.queryOptions({ projectId, amountCents: cents ?? 1, paidOn }), enabled: !!cents && cents > 0 && /^\d{4}-\d{2}-\d{2}$/.test(paidOn) });
  const record = useMutation(
    trpc.capital.recordDistribution.mutationOptions({
      onSuccess: async (r) => {
        toast("success", `Distribution #${r.number} recorded`);
        await refresh();
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Record a distribution"
      description="Split by the waterfall as of the date paid. Check the split before saving."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={record.isPending} disabled={!cents || !preview.data || preview.data.unallocated > 0} onClick={() => record.mutate({ projectId, amountCents: cents!, paidOn, note: note || null })}>
            Record
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount" htmlFor="dist-amount">
          <Input id="dist-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="num" />
        </Field>
        <Field label="Paid on" htmlFor="dist-on">
          <Input id="dist-on" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className="num" />
        </Field>
        <Field label="Note" htmlFor="dist-note" className="sm:col-span-2">
          <Input id="dist-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Refinance proceeds" />
        </Field>
      </div>
      {preview.data && (
        <div className="mt-5 rounded-panel border border-border">
          <ul className="num divide-y divide-border text-[14px]">
            {preview.data.shares.map((s) => (
              <li key={s.investorId} className="flex flex-wrap justify-between gap-2 px-4 py-2">
                <span>{s.investorName}</span>
                <span className="text-muted">
                  {$(s.roc + s.pref + s.profit)} <span className="text-[12px]">(capital {$(s.roc)} · pref {$(s.pref)} · profit {$(s.profit)})</span>
                </span>
              </li>
            ))}
            <li className="flex justify-between gap-2 px-4 py-2">
              <span>Sponsor promote</span>
              <span className="text-muted">{$(preview.data.gp)}</span>
            </li>
          </ul>
          {preview.data.unallocated > 0 && <p className="px-4 pb-3 text-[13px] text-attention-text">{$(preview.data.unallocated)} has nowhere to go. Check the tiers.</p>}
        </div>
      )}
      {preview.isError && <p className="mt-3 text-[13px] text-blocked-text">{errorMessage(preview.error)}</p>}
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-blocked-text">
          {error}
        </p>
      )}
      <Badge className="mt-4">The split is worked out again on save, from the records as they are then.</Badge>
    </Dialog>
  );
}
