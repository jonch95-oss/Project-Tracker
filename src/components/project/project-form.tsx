"use client";

import { useState } from "react";
import { centsToInput, FieldError, optionalDecimal2, optionalInt, optionalMoney } from "@/core/forms";
import { BOROUGHS, PROJECT_TYPE_LABEL, type ProjectTypeKey } from "@/core/labels";
import { PROJECT_STATUS_LABEL, PROJECT_STATUSES, type ProjectStatus } from "@/core/portfolio";
import { IconChevronDown } from "@/components/ui/icons";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
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
}: {
  idPrefix: string;
  mode: "create" | "edit";
  defaults?: ProjectFormDefaults;
  companies: { id: string; name: string }[] | undefined;
  fieldError: FieldError | null;
  showHeadline: boolean;
}) {
  const err = (k: string) => (fieldError?.field === k ? fieldError.message : null);
  const id = (k: string) => `${idPrefix}-${k}`;
  const factsHaveValues = !!defaults.facts && Object.values(defaults.facts).some((v) => v != null && v !== "");
  const [factsOpen, setFactsOpen] = useState(mode === "edit" || factsHaveValues);
  const [finOpen, setFinOpen] = useState(mode === "edit");
  const factsErr = fieldError && ["lotAreaSqft", "residFar", "builtFar", "unusedZsf", "units", "grossSf", "sellableSf"].includes(fieldError.field);
  const finErr = fieldError && ["purchasePrice", "totalBudget", "projectedSellout"].includes(fieldError.field);

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
        <Input id={id("bbl")} name="bbl" inputMode="numeric" maxLength={12} defaultValue={defaults.bbl ?? ""} className="num" aria-invalid={!!err("bbl") || undefined} autoComplete="off" />
      </Field>
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
