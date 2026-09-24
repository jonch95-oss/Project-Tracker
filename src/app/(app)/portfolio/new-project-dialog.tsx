"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { readProjectForm, ProjectFormFields, type ProjectFormValues } from "@/components/project/project-form";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Select, Skeleton, Switch } from "@/components/ui/primitives";
import { FieldError } from "@/core/forms";
import { PROJECT_TYPE_LABEL } from "@/core/labels";
import { generateChecklist } from "@/core/templates";
import { impliedToggles, irrelevantToggles, TOGGLES } from "@/core/toggles";
import { errorMessage, useTRPC } from "@/lib/trpc";

/**
 * New project in two steps (brief §5.1): the property, then the site
 * conditions that shape its checklist, with a live count of what the
 * template will generate.
 */
export function NewProjectDialog({ open, onClose, showHeadline }: { open: boolean; onClose: () => void; showHeadline: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const companies = useQuery({ ...trpc.companies.list.queryOptions(), enabled: open });
  const templates = useQuery({ ...trpc.templates.list.queryOptions(), enabled: open });
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [values, setValues] = useState<ProjectFormValues | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [toggles, setToggles] = useState<string[]>([]);
  // Bumped after each create so the next open starts with an empty form.
  const [formKey, setFormKey] = useState(0);

  const type = values?.type ?? null;
  const forType = (templates.data ?? []).filter((t) => t.projectType === type);
  const chosen = templateId && forType.some((t) => t.id === templateId) ? templateId : (forType.find((t) => t.isDefault)?.id ?? forType[0]?.id ?? null);
  const def = useQuery({ ...trpc.templates.get.queryOptions({ templateId: chosen ?? "00000000-0000-0000-0000-000000000000" }), enabled: open && step === 2 && !!chosen });
  const preview = useMemo(() => {
    if (!def.data || !type) return null;
    const on = new Set([...toggles, ...impliedToggles(type)]);
    const g = generateChecklist(def.data.definition, on);
    return { phases: g.phases.length, tasks: g.tasks.length, byPhase: g.phases.map((p) => ({ name: p.name, n: g.tasks.filter((t) => t.phaseKey === p.key).length })) };
  }, [def.data, type, toggles]);

  const reset = () => {
    setFormKey((k) => k + 1);
    setStep(1);
    setValues(null);
    setToggles([]);
    setTemplateId(null);
  };
  const create = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: async ({ id }) => {
        reset();
        await qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
        toast("success", "Project created");
        onClose();
        router.push(`/projects/${id}?tab=checklist`);
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );

  function next(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldError(null);
    try {
      const v = readProjectForm(e.currentTarget);
      if (values && v.type !== values.type) {
        setToggles([]);
        setTemplateId(null);
      }
      setValues(v);
      setStep(2);
    } catch (err) {
      if (err instanceof FieldError) setFieldError(err);
      else throw err;
    }
  }

  function submit() {
    if (!values || !chosen) return;
    setError(null);
    create.mutate({
      name: values.name,
      address: values.address,
      borough: values.borough,
      bbl: values.bbl,
      type: values.type,
      companyId: values.companyId,
      facts: values.facts,
      headline: showHeadline ? values.headline : undefined,
      templateId: chosen,
      toggles,
    });
  }

  const hidden = type ? new Set(irrelevantToggles(type)) : new Set<string>();
  const implied = type ? new Set<string>(impliedToggles(type)) : new Set<string>();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size={step === 2 ? "lg" : "md"}
      title={step === 1 ? "New project" : "Site conditions"}
      description={
        step === 1
          ? "Step 1 of 2: the property. Next you answer a few questions that shape its checklist."
          : `Step 2 of 2: ${values?.name}. Each “yes” adds the tasks that go with it; you can change these later.`
      }
      footer={
        step === 1 ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="new-project" disabled={!companies.data}>
              Next
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep(1)} className="mr-auto">
              Back
            </Button>
            <Button onClick={submit} disabled={!chosen} loading={create.isPending}>
              Create project
            </Button>
          </>
        )
      }
    >
      {!companies.data ? (
        <Skeleton className="h-64 rounded-panel" />
      ) : (
        <>
          {/* Step 1 stays mounted while step 2 shows, so "Back" keeps everything typed. */}
          <form key={formKey} id="new-project" onSubmit={next} hidden={step !== 1}>
            <ProjectFormFields idPrefix="np" mode="create" companies={companies.data} fieldError={fieldError} showHeadline={showHeadline} />
          </form>
          {step === 2 && type && (
            <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="flex flex-col gap-5">
                <Field label="Template" htmlFor="np-template" hint={`Checklists for ${PROJECT_TYPE_LABEL[type].toLowerCase()} projects.`}>
                  <Select id="np-template" value={chosen ?? ""} onChange={(e) => setTemplateId(e.target.value)} disabled={!templates.data}>
                    {forType.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.isDefault ? " (default)" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                <ul className="flex flex-col gap-4">
                  {TOGGLES.filter((t) => !hidden.has(t.key) || implied.has(t.key)).map((t) => (
                    <li key={t.key}>
                      <Switch
                        id={`np-tg-${t.key}`}
                        checked={implied.has(t.key) || toggles.includes(t.key)}
                        disabled={implied.has(t.key)}
                        onChange={(v) => setToggles((cur) => (v ? [...cur, t.key] : cur.filter((x) => x !== t.key)))}
                        label={t.question}
                        description={implied.has(t.key) ? "Yes, by the project type." : "hint" in t ? t.hint : undefined}
                      />
                    </li>
                  ))}
                </ul>
              </div>
              <aside aria-live="polite" className="h-fit rounded-panel border border-border bg-sunken/50 p-5 lg:sticky lg:top-0">
                <p className="eyebrow mb-3">The checklist</p>
                {!preview ? (
                  <Skeleton className="h-40" />
                ) : (
                  <>
                    <p className="serif text-heading">
                      <span className="num">{preview.tasks}</span> tasks in <span className="num">{preview.phases}</span> phases
                    </p>
                    <ul className="mt-4 flex flex-col gap-1.5 text-[13px]">
                      {preview.byPhase.map((p) => (
                        <li key={p.name} className="flex justify-between gap-3">
                          <span className="truncate text-muted">{p.name}</span>
                          <span className="num">{p.n}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </aside>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-4 text-[13px] text-blocked-text">
              {error}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
