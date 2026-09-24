"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconPlus } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import {
  Button,
  Field,
  Input,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  type Tone,
} from "@/components/ui/primitives";
import {
  centsToInput,
  FieldError,
  optionalDecimal2,
  optionalInt,
  optionalMoney,
} from "@/core/forms";
import { formatMoney } from "@/core/money";
import { formatIsoDate, todayET } from "@/core/time";
import {
  EXPOSURES,
  OUTDOOR_TYPES,
  SELECTION_CATEGORIES,
  type SelectionState,
} from "@/core/units";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";
import { PersonSelect } from "./field/people";

type Data = RouterOutputs["units"]["list"];
type Unit = Data["units"][number];
type Selection = Unit["selections"][number];

const STATE: Record<SelectionState, { label: string; tone: Tone }> = {
  signed: { label: "Signed off", tone: "done" },
  overdue: { label: "Sign-off overdue", tone: "blocked" },
  due_soon: { label: "Sign-off due soon", tone: "attention" },
  pending: { label: "Awaiting sign-off", tone: "neutral" },
};
const UNIT_STATUS: Record<string, string> = {
  available: "Available",
  reserved: "Reserved",
  contract: "In contract",
  closed: "Closed",
};
const d = (iso: string | null) =>
  iso
    ? formatIsoDate(iso, { month: "short", day: "numeric", year: "numeric" })
    : "";
const n = (v: number | null | undefined, suffix = "") =>
  v == null ? null : `${v.toLocaleString("en-US")}${suffix}`;

/** Module L: the unit schedule (shared with the sales tracker) and each buyer's selections, which drive the GC's tasks. */
export function UnitsTab({
  projectId,
  onOpenTask,
}: {
  projectId: string;
  onOpenTask: (id: string) => void;
}) {
  const trpc = useTRPC();
  const q = useQuery(trpc.units.list.queryOptions({ projectId }));
  const [editing, setEditing] = useState<Unit | "new" | null>(null);
  const [selecting, setSelecting] = useState<{
    unit: Unit;
    sel: Selection | null;
  } | null>(null);
  if (q.isPending) return <Skeleton className="h-80 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const { units, summary, access } = q.data;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <dl className="num flex flex-wrap gap-x-8 gap-y-2 text-[13px] text-muted">
          <div>
            <dt className="inline">Units </dt>
            <dd className="inline font-medium text-text">{summary.units}</dd>
          </div>
          <div>
            <dt className="inline">Sellable </dt>
            <dd className="inline font-medium text-text">
              {summary.sf.toLocaleString("en-US")} sf
            </dd>
          </div>
          <div>
            <dt className="inline">Selections awaiting sign-off </dt>
            <dd className="inline font-medium text-text">
              {summary.pendingSignOff}
            </dd>
          </div>
          {summary.overdue > 0 && (
            <div>
              <dt className="inline text-blocked-text">Overdue </dt>
              <dd className="inline font-medium text-blocked-text">
                {summary.overdue}
              </dd>
            </div>
          )}
        </dl>
        {access.canEdit && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <IconPlus size={16} /> Add unit
          </Button>
        )}
      </div>

      {units.length === 0 ? (
        <EmptyState
          title="No units yet"
          body={
            access.canEdit
              ? "Add each unit with its floor, size, layout, exposure and outdoor space. The sales tracker in Financials uses the same list."
              : "The unit schedule shows here once it's set up."
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {units.map((u) => (
            <li
              key={u.id}
              className="rounded-card border border-border bg-surface"
            >
              <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                <button
                  type="button"
                  disabled={!access.canEdit}
                  onClick={() => setEditing(u)}
                  className="min-w-0 text-left"
                >
                  <span className="serif block text-[20px] leading-tight">
                    Unit {u.unit}
                  </span>
                  <span className="num mt-1 block text-[13px] text-muted">
                    {[
                      u.floor && `Floor ${u.floor}`,
                      n(u.sf, " sf"),
                      u.beds != null && `${u.beds} bd`,
                      u.baths != null && `${u.baths} ba`,
                      u.exposure && `${u.exposure} exposure`,
                      u.outdoorType &&
                        `${u.outdoorType}${u.outdoorSf ? ` ${u.outdoorSf.toLocaleString("en-US")} sf` : ""}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </button>
                <div className="flex flex-col items-end gap-1">
                  {access.canEdit && u.selections.length === 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelecting({ unit: u, sel: null })}
                    >
                      <IconPlus size={16} /> Selection
                    </Button>
                  )}
                  {u.status && (
                    <StatusPill
                      tone={
                        u.status === "closed"
                          ? "done"
                          : u.status === "available"
                            ? "neutral"
                            : "accent"
                      }
                    >
                      {UNIT_STATUS[u.status] ?? u.status}
                    </StatusPill>
                  )}
                  {access.canSeePrices && u.askCents != null && (
                    <span className="num text-[13px] text-muted">
                      {formatMoney(u.askCents, { whole: true })}
                      {u.askPsfCents != null &&
                        ` · ${formatMoney(u.askPsfCents, { whole: true })}/sf`}
                    </span>
                  )}
                </div>
              </div>
              {u.selections.length > 0 && (
                <div className="border-t border-border px-5 py-3">
                  {
                    <ul className="flex flex-col divide-y divide-border">
                      {u.selections.map((s) => (
                        <li
                          key={s.id}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
                        >
                          <button
                            type="button"
                            disabled={!access.canEdit}
                            onClick={() => setSelecting({ unit: u, sel: s })}
                            className="min-w-0 flex-1 text-left text-[14px]"
                          >
                            <span className="font-medium">{s.category}:</span>{" "}
                            {s.choice}
                            {s.isUpgrade && (
                              <span className="text-muted">
                                {" "}
                                · upgrade
                                {s.upgradeCents != null
                                  ? ` ${formatMoney(s.upgradeCents, { whole: true })}`
                                  : ""}
                              </span>
                            )}
                            <span className="num block text-[12px] text-muted">
                              {s.signedOffOn
                                ? `Signed ${d(s.signedOffOn)}${s.signedOffName ? ` by ${s.signedOffName}` : ""}`
                                : s.signOffBy
                                  ? `Sign-off by ${d(s.signOffBy)}`
                                  : "No sign-off date"}
                              {s.assigneeName ? ` · GC: ${s.assigneeName}` : ""}
                            </span>
                          </button>
                          <StatusPill tone={STATE[s.state].tone}>
                            {STATE[s.state].label}
                          </StatusPill>
                          {s.taskId && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => onOpenTask(s.taskId!)}
                            >
                              Task
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  }
                  {access.canEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-1"
                      onClick={() => setSelecting({ unit: u, sel: null })}
                    >
                      <IconPlus size={16} /> Add selection
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <UnitDialog
          projectId={projectId}
          unit={editing === "new" ? null : editing}
          canEditPrices={access.canEditPrices}
          onClose={() => setEditing(null)}
        />
      )}
      {selecting && (
        <SelectionDialog
          projectId={projectId}
          unit={selecting.unit}
          sel={selecting.sel}
          canEditPrices={access.canEditPrices}
          onClose={() => setSelecting(null)}
        />
      )}
    </div>
  );
}

function UnitDialog({
  projectId,
  unit,
  canEditPrices,
  onClose,
}: {
  projectId: string;
  unit: Unit | null;
  canEditPrices: boolean;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const save = useMutation(
    trpc.units.saveUnit.mutationOptions({
      onSuccess: async () => {
        toast("success", unit ? "Unit saved" : "Unit added");
        await Promise.all([
          qc.invalidateQueries({
            queryKey: trpc.units.list.queryKey({ projectId }),
          }),
          qc.invalidateQueries({
            queryKey: trpc.financials.overview.queryKey(),
          }),
        ]);
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
      save.mutate({
        projectId,
        id: unit?.id,
        version: unit?.version,
        unit: s("unit"),
        floor: s("floor") || null,
        sf: optionalInt(s("sf"), "sf", "Square feet", 1_000_000),
        beds: optionalDecimal2(s("beds"), "beds", "Bedrooms", 20),
        baths: optionalDecimal2(s("baths"), "baths", "Bathrooms", 20),
        exposure: s("exposure") || null,
        outdoorType: s("outdoorType") || null,
        outdoorSf: optionalInt(
          s("outdoorSf"),
          "outdoorSf",
          "Outdoor space",
          100_000,
        ),
        ...(canEditPrices
          ? { askCents: optionalMoney(s("ask"), "ask", "Asking price") }
          : {}),
      });
    } catch (err) {
      setError(err instanceof FieldError ? err.message : errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={unit ? `Unit ${unit.unit}` : "Add a unit"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="unit-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="unit-form" onSubmit={submit} className="grid grid-cols-2 gap-4">
        <Field label="Unit" htmlFor="u-unit">
          <Input
            id="u-unit"
            name="unit"
            required
            maxLength={40}
            defaultValue={unit?.unit ?? ""}
            placeholder="4B"
          />
        </Field>
        <Field label="Floor" htmlFor="u-floor">
          <Input
            id="u-floor"
            name="floor"
            maxLength={20}
            defaultValue={unit?.floor ?? ""}
          />
        </Field>
        <Field label="Square feet" htmlFor="u-sf">
          <Input
            id="u-sf"
            name="sf"
            inputMode="numeric"
            defaultValue={unit?.sf ?? ""}
            className="num"
          />
        </Field>
        <Field label="Exposure" htmlFor="u-exp">
          <Select
            id="u-exp"
            name="exposure"
            defaultValue={unit?.exposure ?? ""}
          >
            <option value="">—</option>
            {EXPOSURES.map((x) => (
              <option key={x}>{x}</option>
            ))}
            {unit?.exposure &&
              !(EXPOSURES as readonly string[]).includes(unit.exposure) && (
                <option>{unit.exposure}</option>
              )}
          </Select>
        </Field>
        <Field label="Bedrooms" htmlFor="u-beds">
          <Input
            id="u-beds"
            name="beds"
            inputMode="decimal"
            defaultValue={unit?.beds ?? ""}
            className="num"
          />
        </Field>
        <Field label="Bathrooms" htmlFor="u-baths">
          <Input
            id="u-baths"
            name="baths"
            inputMode="decimal"
            defaultValue={unit?.baths ?? ""}
            className="num"
          />
        </Field>
        <Field label="Outdoor space" htmlFor="u-otype">
          <Select
            id="u-otype"
            name="outdoorType"
            defaultValue={unit?.outdoorType ?? ""}
          >
            <option value="">None</option>
            {OUTDOOR_TYPES.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </Select>
        </Field>
        <Field label="Outdoor sf" htmlFor="u-osf">
          <Input
            id="u-osf"
            name="outdoorSf"
            inputMode="numeric"
            defaultValue={unit?.outdoorSf ?? ""}
            className="num"
          />
        </Field>
        {canEditPrices && (
          <Field
            label="Asking price"
            htmlFor="u-ask"
            className="col-span-2"
            hint="$/sf is worked out from the square feet."
          >
            <Input
              id="u-ask"
              name="ask"
              inputMode="decimal"
              defaultValue={centsToInput(unit?.askCents)}
              className="num"
            />
          </Field>
        )}
        {error && (
          <p role="alert" className="col-span-2 text-[13px] text-blocked-text">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function SelectionDialog({
  projectId,
  unit,
  sel,
  canEditPrices,
  onClose,
}: {
  projectId: string;
  unit: Unit;
  sel: Selection | null;
  canEditPrices: boolean;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [assignee, setAssignee] = useState<string | null>(
    sel?.assigneeId ?? null,
  );
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({
        queryKey: trpc.units.list.queryKey({ projectId }),
      }),
      qc.invalidateQueries({ queryKey: trpc.checklist.get.queryKey() }),
    ]);
  const done = (msg: string) => async () => {
    toast("success", msg);
    await refresh();
    onClose();
  };
  const onError = (e: unknown) => setError(errorMessage(e));
  const save = useMutation(
    trpc.units.saveSelection.mutationOptions({
      onSuccess: done(
        sel ? "Selection saved" : "Selection added; the GC has a task",
      ),
      onError,
    }),
  );
  const signOff = useMutation(
    trpc.units.signOff.mutationOptions({
      onSuccess: done("Signed off; the GC's task is live"),
      onError,
    }),
  );
  const clear = useMutation(
    trpc.units.signOff.mutationOptions({
      onSuccess: done("Sign-off cleared"),
      onError,
    }),
  );
  const remove = useMutation(
    trpc.units.deleteSelection.mutationOptions({
      onSuccess: done("Selection removed"),
      onError,
    }),
  );
  const [signer, setSigner] = useState("");
  const [signedOn, setSignedOn] = useState(todayET());

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    try {
      save.mutate({
        projectId,
        id: sel?.id,
        version: sel?.version,
        unitId: unit.id,
        category: s("category") as (typeof SELECTION_CATEGORIES)[number],
        choice: s("choice"),
        signOffBy: s("signOffBy") || null,
        notes: s("notes") || null,
        assigneeId: assignee,
        ...(canEditPrices
          ? {
              upgradeCents: optionalMoney(
                s("upgrade"),
                "upgrade",
                "Upgrade price",
              ),
            }
          : {}),
      });
    } catch (err) {
      setError(err instanceof FieldError ? err.message : errorMessage(err));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        sel
          ? `Unit ${unit.unit}: ${sel.category}`
          : `New selection for unit ${unit.unit}`
      }
      description="Each selection gives the GC a task: waiting on the buyer's sign-off, then live."
      footer={
        <>
          {sel && (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={() => setConfirm(true)}
            >
              Remove
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="sel-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="sel-form"
        onSubmit={submit}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Field label="Category" htmlFor="sel-cat">
          <Select
            id="sel-cat"
            name="category"
            defaultValue={sel?.category ?? "Kitchen"}
          >
            {SELECTION_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field label="Sign-off by" htmlFor="sel-by">
          <Input
            id="sel-by"
            name="signOffBy"
            type="date"
            defaultValue={sel?.signOffBy ?? ""}
            className="num"
          />
        </Field>
        <Field label="Selection" htmlFor="sel-choice" className="sm:col-span-2">
          <Input
            id="sel-choice"
            name="choice"
            required
            maxLength={200}
            defaultValue={sel?.choice ?? ""}
            placeholder="e.g. Calacatta quartz counters, waterfall island"
          />
        </Field>
        {canEditPrices && (
          <Field
            label="Upgrade price"
            htmlFor="sel-up"
            hint="Leave blank for a standard finish."
          >
            <Input
              id="sel-up"
              name="upgrade"
              inputMode="decimal"
              defaultValue={centsToInput(sel?.upgradeCents)}
              className="num"
            />
          </Field>
        )}
        <Field label="GC task goes to" htmlFor="sel-gc">
          <PersonSelect
            id="sel-gc"
            projectId={projectId}
            value={assignee}
            onChange={setAssignee}
          />
        </Field>
        <Field label="Notes" htmlFor="sel-notes" className="sm:col-span-2">
          <Textarea
            id="sel-notes"
            name="notes"
            rows={2}
            maxLength={2000}
            defaultValue={sel?.notes ?? ""}
          />
        </Field>
        {error && (
          <p
            role="alert"
            className="text-[13px] text-blocked-text sm:col-span-2"
          >
            {error}
          </p>
        )}
      </form>
      {sel && (
        <section className="mt-6 rounded-panel bg-sunken px-4 py-4">
          <h3 className="eyebrow mb-3">Buyer sign-off</h3>
          {sel.signedOffOn ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span>
                Signed {d(sel.signedOffOn)}
                {sel.signedOffName ? ` by ${sel.signedOffName}` : ""}
              </span>
              <Button
                size="sm"
                variant="ghost"
                loading={clear.isPending}
                onClick={() =>
                  clear.mutate({
                    projectId,
                    id: sel.id,
                    version: sel.version,
                    signedOffOn: null,
                  })
                }
              >
                Clear sign-off
              </Button>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <Field label="Signed by" htmlFor="sel-signer">
                <Input
                  id="sel-signer"
                  value={signer}
                  onChange={(e) => setSigner(e.target.value)}
                  maxLength={160}
                  placeholder="Buyer's name"
                />
              </Field>
              <Field label="On" htmlFor="sel-signed-on">
                <Input
                  id="sel-signed-on"
                  type="date"
                  value={signedOn}
                  max={todayET()}
                  onChange={(e) => setSignedOn(e.target.value)}
                  className="num"
                />
              </Field>
              <Button
                loading={signOff.isPending}
                disabled={!signedOn}
                onClick={() =>
                  signOff.mutate({
                    projectId,
                    id: sel.id,
                    version: sel.version,
                    signedOffOn: signedOn,
                    signedOffName: signer || null,
                  })
                }
              >
                Record sign-off
              </Button>
            </div>
          )}
        </section>
      )}
      <ConfirmDialog
        open={confirm}
        title="Remove this selection?"
        body="Its GC task goes too, unless work has started on it."
        confirmLabel="Remove"
        danger
        busy={remove.isPending}
        onCancel={() => setConfirm(false)}
        onConfirm={() =>
          remove.mutate({ projectId, id: sel!.id, version: sel!.version })
        }
      />
    </Dialog>
  );
}
