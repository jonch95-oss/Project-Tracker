"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { readProjectForm, ProjectFormFields } from "@/components/project/project-form";
import { useRouter } from "next/navigation";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Button, Skeleton } from "@/components/ui/primitives";
import { FieldError } from "@/core/forms";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";

type Project = RouterOutputs["projects"]["get"];

export function EditProjectDialog({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const companies = useQuery({ ...trpc.companies.list.queryOptions(), enabled: open });
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Money is edited on the Financials tab now (its headline follows the budget and unit schedule).
  const showHeadline = false;

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ projectId: project.id }) }),
      qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() }),
    ]);
  const update = useMutation(trpc.projects.update.mutationOptions());

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldError(null);
    let v;
    try {
      v = readProjectForm(e.currentTarget);
    } catch (err) {
      if (err instanceof FieldError) return setFieldError(err);
      throw err;
    }
    try {
      await update.mutateAsync({
        projectId: project.id,
        version: project.version,
        name: v.name,
        address: v.address,
        borough: v.borough,
        bbl: v.bbl,
        companyId: v.companyId,
        status: v.status,
        facts: v.facts,
      });
      toast("success", "Project saved");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      await refresh();
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit project"
      footer={
        <>
          {!project.archivedAt && <ArchiveButton projectId={project.id} onDone={onClose} />}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="edit-project" disabled={!companies.data} loading={update.isPending}>
            Save
          </Button>
        </>
      }
    >
      {/* Keyed on version so reopening after someone else's save shows fresh values. The form waits
          for the company list: an uncontrolled select mounted without its options would silently
          pick the first company. */}
      {!companies.data ? (
        <Skeleton className="h-64 rounded-panel" />
      ) : (
      <form key={`${project.version}-${open}`} id="edit-project" onSubmit={onSubmit}>
        <ProjectFormFields
          idPrefix="ep"
          mode="edit"
          companies={companies.data}
          fieldError={fieldError}
          showHeadline={showHeadline}
          defaults={{
            name: project.name,
            address: project.address,
            borough: project.borough as "Brooklyn",
            bbl: project.bbl,
            companyId: project.companyId,
            status: project.status,
            facts: {
              description: project.description,
              lotAreaSqft: project.lotAreaSqft,
              lotFrontFt: project.lotFrontFt,
              lotDepthFt: project.lotDepthFt,
              zoning: project.zoning,
              residFar: project.residFar,
              builtFar: project.builtFar,
              unusedZsf: project.unusedZsf,
              units: project.units,
              grossSf: project.grossSf,
              sellableSf: project.sellableSf,
            },
            headline: project.headline,
          }}
        />
        {error && (
          <p role="alert" className="mt-4 text-[13px] text-blocked-text">
            {error}
          </p>
        )}
      </form>
      )}
    </Dialog>
  );
}

/** Archive: leaves the portfolio for everyone, deletes nothing. */
function ArchiveButton({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const archive = useMutation(
    trpc.projects.setArchived.mutationOptions({
      onSuccess: async () => {
        toast("success", "Project archived");
        await qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
        await qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ projectId }) });
        onDone();
        router.push("/portfolio");
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  return (
    <>
      <Button variant="ghost" onClick={() => setConfirm(true)} className="mr-auto text-blocked-text">
        Archive project
      </Button>
      <ConfirmDialog
        open={confirm}
        title="Archive this project?"
        body="It leaves the portfolio for everyone. Nothing is deleted, and you can restore it from “Show archived”."
        confirmLabel="Archive"
        danger
        busy={archive.isPending}
        onCancel={() => setConfirm(false)}
        onConfirm={() => archive.mutate({ projectId, archived: true })}
      />
    </>
  );
}
