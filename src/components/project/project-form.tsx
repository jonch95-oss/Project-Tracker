"use client";

import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { centsToInput, FieldError, optionalDecimal2, optionalInt, optionalMoney } from "@/core/forms";
import { BOROUGHS, PROJECT_TYPE_LABEL, type ProjectTypeKey } from "@/core/labels";
import { PROJECT_STATUS_LABEL, PROJECT_STATUSES, type ProjectStatus } from "@/core/portfolio";
import { IconChevronDown } from "@/components/ui/icons";
import { Button, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/cn";

type Borough = (typeof BOROUGHS)[number];

export interface ProjectFormValues {
  name: string;
  address: string;
  borough: Borough;
  bbl: string | null;
  type: ProjectTypeKey;
  companyId: string;
  status: ProjectStatus;
  facts: {
    description: string | null;
    lotAreaSqft: number | null;
    lotFrontFt: number | null;
    lotDepthFt: number | null;
    zoning: string | null;
    residFar: number | null;
    builtFar: number | null;
    unusedZsf: number | null;
    units: number | null;
    grossSf: number | null;
    sellableSf: number | null;
  };
  headline: { purchasePriceCents: number | null; totalBudgetCents: number | null; projectedSelloutCents: number | null };
}

export type ProjectFormDefaults = Partial<Omit<ProjectFormValues, "facts" | "headline">> & {
  facts?: Partial<ProjectFormValues["facts"]>;
  headline?: Partial<ProjectFormValues["headline"]> | null;
};

/** Read and validate the form. Throws FieldError naming the field to highlight. */
export function readProjectForm(form: HTMLFormElement): ProjectFormValues {
  const f = new FormData(form);
  const str = (k: string) => String(f.get(k) ?? "").trim();
  const bbl = str("bbl").replace(/\D/g, "");
  if (bbl && !/^[1-5]\d{9}$/.test(bbl)) throw new FieldError("bbl", "BBL is 10 digits: borough (1–5), block (5), lot (4).");
  return {
    name: str("name"),
    address: str("address"),
    borough: (str("borough") || "Brooklyn") as Borough,
    bbl: bbl || null,
    type: (str("type") || "ground_up_condo") as ProjectTypeKey,
    companyId: str("companyId"),
    status: (str("status") || "active") as ProjectStatus,
    facts: {
      description: str("description") || null,
      lotAreaSqft: optionalInt(str("lotAreaSqft"), "lotAreaSqft", "Lot area"),
      lotFrontFt: optionalDecimal2(str("lotFrontFt"), "lotFrontFt", "Lot frontage", 100_000),
      lotDepthFt: optionalDecimal2(str("lotDepthFt"), "lotDepthFt", "Lot depth", 100_000),
      zoning: str("zoning") || null,
      residFar: optionalDecimal2(str("residFar"), "residFar", "Residential FAR"),
      builtFar: optionalDecimal2(str("builtFar"), "builtFar", "Built FAR"),
      unusedZsf: optionalInt(str("unusedZsf"), "unusedZsf", "Unused ZSF"),
      units: optionalInt(str("units"), "units", "Units", 10_000),
      grossSf: optionalInt(str("grossSf"), "grossSf", "Gross SF"),
      sellableSf: optionalInt(str("sellableSf"), "sellableSf", "Sellable SF"),
    },
    headline: {
      purchasePriceCents: optionalMoney(str("purchasePrice"), "purchasePrice", "Purchase price"),
      totalBudgetCents: optionalMoney(str("totalBudget"), "totalBudget", "Total budget"),
      projectedSelloutCents: optionalMoney(str("projectedSellout"), "projectedSellout", "Projected sellout"),
    },
  };
}

function Num({ id, name, label, defaultValue, hint, error, decimal, className }: { id: string; name: string; label: string; defaultValue?: number | null; hint?: string; error?: string | null; decimal?: boolean; className?: string }) {
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error} className={className}>
      <Input
        id={id}
        name={name}
        inputMode={decimal ? "decimal" : "numeric"}
        defaultValue={defaultValue == null ? "" : decimal ? String(defaultValue) : defaultValue.toLocaleString("en-US")}
        aria-invalid={!!error || undefined}
        className="num"
        autoComplete="off"
      />
    </Field>
  );
}

function Money({ id, name, label, defaultValue, error }: { id: string; name: string; label: string; defaultValue?: number | null; error?: string | null }) {
  return (
    <Field label={label} htmlFor={id} error={error}>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">$</span>
        <Input id={id} name={name} inputMode="decimal" defaultValue={centsToInput(defaultValue)} aria-invalid={!!error || undefined} className="num pl-7" autoComplete="off" />
      </div>
    </Field>
  );
}

/**
 * Fields shared by "New project" and "Edit project". The key-facts and
 * financial sections fold away so creating a project stays a 20-second job.
 */
export function ProjectFormFields({
  idPrefix,
  mode,
  defaults = {},
  companies,
  fieldError,
  showHeadline,
  canLookUp = true,
}: {
  idPrefix: string;
  mode: "create" | "edit";
  defaults?: ProjectFormDefaults;
  companies: { id: string; name: string }[] | undefined;
  fieldError: FieldError | null;
  showHeadline: boolean;
  /** Owners and admins can fill the lot's facts from PLUTO. */
  canLookUp?: boolean;
}) {
  const err = (k: string) => (fieldError?.field === k ? fieldError.message : null);
  const id = (k: string) => `${idPrefix}-${k}`;
  const factsHaveValues = !!defaults.facts && Object.values(defaults.facts).some((v) => v != null && v !== "");
  const [factsOpen, setFactsOpen] = useState(mode === "edit" || factsHaveValues);
  const [finOpen, setFinOpen] = useState(mode === "edit");
  const factsErr = fieldError && ["lotAreaSqft", "lotFrontFt", "lotDepthFt", "residFar", "builtFar", "unusedZsf", "units", "grossSf", "sellableSf"].includes(fieldError.field);
  const finErr = fieldError && ["purchasePrice", "totalBudget", "projectedSellout"].includes(fieldError.field);
  const lot = useLotLookup(() => setFactsOpen(true));

  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field label="Project name" htmlFor={id("name")} className="sm:col-span-2" error={err("name")}>
        <Input id={id("name")} name="name" required maxLength={160} defaultValue={defaults.name} placeholder="e.g. Sterling Place Townhouse" />
      </Field>
      <Field label="Address" htmlFor={id("address")} className="sm:col-span-2" error={err("address")} hint="Street address. The map pin and BBL are looked up from the city's address data.">
        <Input id={id("address")} name="address" required minLength={3} maxLength={200} defaultValue={defaults.address} placeholder="412 Sterling Place" autoComplete="off" />
      </Field>
      <Field label="Borough" htmlFor={id("borough")}>
        <Select id={id("borough")} name="borough" defaultValue={defaults.borough ?? "Brooklyn"}>
          {BOROUGHS.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </Select>
      </Field>
      <Field label="BBL" htmlFor={id("bbl")} hint="10 digits, e.g. 3011370045. Leave blank to look it up." error={err("bbl")}>
        <Input
          id={id("bbl")}
          name="bbl"
          inputMode="numeric"
          maxLength={12}
          defaultValue={defaults.bbl ?? ""}
          className="num"
          aria-invalid={!!err("bbl") || undefined}
          autoComplete="off"
          onBlur={(e) => {
            // A new project with a full BBL fills its facts straight away.
            if (mode === "create" && /^[1-5]\d{9}$/.test(e.currentTarget.value.replace(/\D/g, ""))) lot.run(e.currentTarget.form);
          }}
        />
      </Field>
      {canLookUp && <LotLookup state={lot} />}
      {mode === "create" ? (
        <Field label="Project type" htmlFor={id("type")} className="sm:col-span-2" hint="Sets the phases. You can skip or restore phases later.">
          <Select id={id("type")} name="type" defaultValue={defaults.type ?? "ground_up_condo"}>
            {Object.entries(PROJECT_TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <Field label="Status" htmlFor={id("status")}>
          <Select id={id("status")} name="status" defaultValue={defaults.status ?? "active"}>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {PROJECT_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Company" htmlFor={id("company")} className={mode === "create" ? "sm:col-span-2" : undefined} error={err("companyId")}>
        <Select id={id("company")} name="companyId" required defaultValue={defaults.companyId}>
          {companies?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>

      <Disclosure open={factsOpen || !!factsErr} onToggle={() => setFactsOpen((o) => !o)} title="Key facts" subtitle="Lot, zoning, FAR, units, square footage">
        <Num id={id("lot")} name="lotAreaSqft" label="Lot area (sf)" defaultValue={defaults.facts?.lotAreaSqft} error={err("lotAreaSqft")} />
        <div className="grid grid-cols-2 gap-3">
          <Num id={id("lotfront")} name="lotFrontFt" label="Frontage (ft)" decimal defaultValue={defaults.facts?.lotFrontFt} error={err("lotFrontFt")} />
          <Num id={id("lotdepth")} name="lotDepthFt" label="Depth (ft)" decimal defaultValue={defaults.facts?.lotDepthFt} error={err("lotDepthFt")} />
        </div>
        <Field label="Zoning" htmlFor={id("zoning")}>
          <Input id={id("zoning")} name="zoning" maxLength={60} defaultValue={defaults.facts?.zoning ?? ""} placeholder="R6B" autoComplete="off" />
        </Field>
        <Num id={id("rfar")} name="residFar" label="Residential FAR" decimal defaultValue={defaults.facts?.residFar} error={err("residFar")} hint="From PLUTO's residfar, not the district default." />
        <Num id={id("bfar")} name="builtFar" label="Built FAR" decimal defaultValue={defaults.facts?.builtFar} error={err("builtFar")} />
        <Num id={id("uzsf")} name="unusedZsf" label="Unused ZSF" defaultValue={defaults.facts?.unusedZsf} error={err("unusedZsf")} />
        <Num id={id("units")} name="units" label="Units" defaultValue={defaults.facts?.units} error={err("units")} />
        <Num id={id("gsf")} name="grossSf" label="Gross SF" defaultValue={defaults.facts?.grossSf} error={err("grossSf")} />
        <Num id={id("ssf")} name="sellableSf" label="Sellable SF" defaultValue={defaults.facts?.sellableSf} error={err("sellableSf")} />
        <Field label="Notes" htmlFor={id("desc")} className="sm:col-span-2">
          <Textarea id={id("desc")} name="description" maxLength={2000} defaultValue={defaults.facts?.description ?? ""} rows={3} />
        </Field>
      </Disclosure>

      {showHeadline && (
        <Disclosure open={finOpen || !!finErr} onToggle={() => setFinOpen((o) => !o)} title="Headline financials" subtitle="Visible only to people with financial access">
          <Money id={id("price")} name="purchasePrice" label="Purchase price" defaultValue={defaults.headline?.purchasePriceCents} error={err("purchasePrice")} />
          <Money id={id("budget")} name="totalBudget" label="Total project budget" defaultValue={defaults.headline?.totalBudgetCents} error={err("totalBudget")} />
          <Money id={id("sellout")} name="projectedSellout" label="Projected sellout" defaultValue={defaults.headline?.projectedSelloutCents} error={err("projectedSellout")} />
        </Disclosure>
      )}
    </div>
  );
}

function Disclosure({ open, onToggle, title, subtitle, children }: { open: boolean; onToggle: () => void; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="sm:col-span-2 rounded-panel border border-border">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left">
        <span>
          <span className="block text-[14px] font-medium">{title}</span>
          <span className="block text-[12px] text-muted">{subtitle}</span>
        </span>
        <IconChevronDown size={18} className={cn("shrink-0 text-muted transition-transform duration-200", open && "rotate-180")} />
      </button>
      {/* Hidden, not unmounted, so values survive folding and still submit. */}
      <div hidden={!open} className="grid gap-5 border-t border-border p-4 sm:grid-cols-2">
        {children}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Module A: fill the lot's facts from PLUTO                           */
/* ------------------------------------------------------------------ */

/** Form field → PLUTO fact. Only empty fields are filled; what someone typed stays. */
const LOT_FIELDS = [
  ["lotAreaSqft", "lotAreaSqft", "lot area"],
  ["lotFrontFt", "lotFrontFt", "frontage"],
  ["lotDepthFt", "lotDepthFt", "depth"],
  ["zoning", "zoning", "zoning"],
  ["residFar", "residFar", "residential FAR"],
  ["builtFar", "builtFar", "built FAR"],
  ["unusedZsf", "unusedZsf", "unused ZSF"],
] as const;

type LotMessage = { tone: "ok" | "info" | "warn"; text: string } | null;

function useLotLookup(onFilled: () => void) {
  const trpc = useTRPC();
  const lookup = useMutation(trpc.projects.lookupLot.mutationOptions());
  const [message, setMessage] = useState<LotMessage>(null);
  const last = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  async function run(form: HTMLFormElement | null) {
    if (!form || lookup.isPending) return;
    formRef.current = form;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
    const bblRaw = (field("bbl")?.value ?? "").replace(/\D/g, "");
    const address = (field("address")?.value ?? "").trim();
    const borough = (field("borough")?.value ?? "Brooklyn") as Borough;
    const key = `${bblRaw}|${address}|${borough}`;
    if (last.current === key && message?.tone === "ok") return;
    last.current = key;
    if (bblRaw && !/^[1-5]\d{9}$/.test(bblRaw)) return setMessage({ tone: "warn", text: "Fix the BBL first: 10 digits, borough first." });
    if (!bblRaw && address.length < 3) return setMessage({ tone: "info", text: "Type the address or the BBL, then look it up." });
    setMessage({ tone: "info", text: "Looking up the lot in PLUTO…" });
    let r;
    try {
      r = await lookup.mutateAsync({ bbl: bblRaw || undefined, address: address || undefined, borough });
    } catch {
      return setMessage({ tone: "warn", text: "Couldn't look the lot up just now. Fill the facts in by hand or try again." });
    }
    if (r.status === "no_bbl") return setMessage({ tone: "warn", text: "The city's address data didn't give a BBL for that address. Type the BBL to look it up." });
    if (r.status === "wrong_borough") return setMessage({ tone: "warn", text: "That BBL is in a different borough from the one chosen." });
    if (r.status === "unavailable") return setMessage({ tone: "warn", text: "NYC Open Data isn't answering right now. Fill the facts in by hand or try again later." });
    if (r.status === "not_found") return setMessage({ tone: "warn", text: `PLUTO has no lot ${r.bbl}. Check the BBL; a new condo lot can take a release or two to appear.` });
    const bblInput = field("bbl");
    if (bblInput && !bblInput.value.trim()) bblInput.value = r.bbl;
    const filled: string[] = [];
    const kept: string[] = [];
    for (const [name, key2, label] of LOT_FIELDS) {
      const v = r.facts[key2];
      const input = field(name);
      if (v === null || v === undefined || !input) continue;
      if (input.value.trim()) {
        kept.push(label);
        continue;
      }
      // Whole square feet read best with commas; FAR and feet are decimals, and their fields don't take commas.
      input.value = typeof v === "number" && (name === "lotAreaSqft" || name === "unusedZsf") ? v.toLocaleString("en-US") : String(v);
      filled.push(label);
    }
    onFilled();
    const where = r.facts.address ? ` (${r.facts.address})` : "";
    const release = r.facts.version ? `PLUTO ${r.facts.version}` : "PLUTO";
    setMessage({
      tone: "ok",
      text: filled.length
        ? `Filled ${filled.join(", ")} from ${release}${where}.${kept.length ? ` Kept what you typed for ${kept.join(", ")}.` : ""}`
        : `${release}${where} matches; every fact was already filled in.`,
    });
  }
  return { run, busy: lookup.isPending, message, form: formRef };
}

function LotLookup({ state }: { state: ReturnType<typeof useLotLookup> }) {
  return (
    <div className="flex flex-col justify-end gap-2">
      <Button type="button" variant="secondary" size="sm" loading={state.busy} onClick={(e) => state.run(e.currentTarget.form)} className="self-start">
        Fill facts from PLUTO
      </Button>
      {state.message && (
        <p role="status" className={cn("text-[13px]", state.message.tone === "ok" ? "text-done-text" : state.message.tone === "warn" ? "text-attention-text" : "text-muted")}>
          {state.message.text}
        </p>
      )}
    </div>
  );
}
