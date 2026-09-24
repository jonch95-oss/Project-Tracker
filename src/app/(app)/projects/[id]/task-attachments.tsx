"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  IconCamera,
  IconClose,
  IconPaperclip,
  IconPlus,
} from "@/components/ui/icons";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Select, Skeleton } from "@/components/ui/primitives";
import { formatFileSize } from "@/core/files";
import { cn } from "@/lib/cn";
import { cameraOptions } from "@/lib/camera";
import { largeFiles, useFileUpload } from "@/lib/file-upload";
import { compressPhoto, PhotoError } from "@/lib/photo-upload";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  FileIcon,
  FileSheet,
  UploadQueue,
  useInvalidateFiles,
} from "./files-tab";

/**
 * A task's attachments (brief §14: files live in a folder and show on the
 * task too). Upload straight onto the task, or attach something already in
 * Files. A required attachment is called out until one is added.
 */
export function TaskAttachments({
  projectId,
  taskId,
  required,
  canWork,
  highlight,
}: {
  projectId: string;
  taskId: string;
  required: string | null;
  canWork: boolean;
  highlight?: boolean;
}) {
  const trpc = useTRPC();
  const toast = useToast();
  const list = useQuery(trpc.files.forTask.queryOptions({ projectId, taskId }));
  const folders = useQuery(trpc.files.folders.queryOptions({ projectId }));
  const invalidate = useInvalidateFiles(projectId);
  const up = useFileUpload(projectId);
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [shooting, setShooting] = useState(false);
  const [folderId, setFolderId] = useState<string>("");
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const detach = useMutation(
    trpc.files.detach.mutationOptions({
      onError: (e) => toast("error", errorMessage(e)),
      onSettled: invalidate,
    }),
  );

  const visibleFolders = folders.data?.folders ?? [];
  // Blank = let the server file it by the task's phase (it may be a folder this person can't browse).
  const target = folderId;
  const files = list.data?.files ?? [];
  const missing =
    !!required && files.length === 0 && (list.data?.hidden ?? 0) === 0;
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (highlight)
      section.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlight]);

  const pick = async (fl: FileList | null) => {
    const chosen = [...(fl ?? [])];
    if (input.current) input.current.value = "";
    if (!chosen.length) return;
    if (
      largeFiles(chosen).length &&
      !window.confirm(
        "Over 100 MB. All project files share 10 GB of storage — upload anyway?",
      )
    )
      return;
    const r = await up.upload(
      chosen,
      target ? { folderId: target, taskId } : { taskId },
    );
    if (r.ok)
      toast("success", r.ok === 1 ? "Attached" : `${r.ok} files attached`);
    await invalidate();
  };

  // A photo taken for the task: compressed and date-stamped on the phone, then attached like any file.
  const shoot = async (fl: FileList | null) => {
    const file = fl?.[0];
    if (camera.current) camera.current.value = "";
    if (!file) return;
    setShooting(true);
    try {
      const c = await compressPhoto(file, await cameraOptions());
      const when = (c.takenAt ?? new Date())
        .toISOString()
        .slice(0, 16)
        .replace("T", " ")
        .replace(":", "-");
      const named = new File(
        [c.full],
        `Photo ${when}.${c.contentType === "image/webp" ? "webp" : "jpg"}`,
        { type: c.contentType },
      );
      const r = await up.upload(
        [named],
        target ? { folderId: target, taskId } : { taskId },
      );
      if (r.ok) toast("success", "Photo attached");
      await invalidate();
    } catch (e) {
      toast("error", e instanceof PhotoError ? e.message : errorMessage(e));
    } finally {
      setShooting(false);
    }
  };

  return (
    <section
      ref={section}
      aria-labelledby="td-att-h"
      id="task-attachments"
      className={cn(
        "scroll-mt-24 rounded-panel",
        highlight &&
          missing &&
          "ring-2 ring-attention ring-offset-4 ring-offset-surface",
      )}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3
          id="td-att-h"
          className="flex items-center gap-2 text-[13px] font-medium"
        >
          <IconPaperclip size={16} /> Attachments
        </h3>
        {canWork && folders.data && (
          <div className="flex flex-wrap items-center gap-2">
            {visibleFolders.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPicking(true)}
              >
                From Files
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => camera.current?.click()}
              loading={shooting}
            >
              <IconCamera size={16} /> Take photo
            </Button>
            <input
              ref={camera}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => void shoot(e.target.files)}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => input.current?.click()}
              loading={up.busy}
            >
              <IconPlus size={16} /> Upload
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => void pick(e.target.files)}
            />
          </div>
        )}
      </div>
      {missing && (
        <p className="mb-2 rounded-panel bg-attention-tint/60 px-3 py-2 text-[13px] text-attention-text">
          Needs {required} before it can be checked off.
        </p>
      )}
      {canWork && visibleFolders.length > 1 && (
        <div className="mb-3 max-w-xs">
          <Field label="Uploads go to" htmlFor="att-folder">
            <Select
              id="att-folder"
              value={target}
              onChange={(e) => setFolderId(e.target.value)}
            >
              <option value="">The folder for this phase</option>
              {visibleFolders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      <UploadQueue items={up.items} onClear={up.clear} />
      {list.isPending ? (
        <Skeleton className="h-12 rounded-panel" />
      ) : files.length === 0 ? (
        !missing && <p className="text-sm text-muted">None.</p>
      ) : (
        <ul className="divide-y divide-border rounded-panel border border-border">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2">
              <button
                type="button"
                onClick={() => setOpen(f.id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <FileIcon
                  name={f.name}
                  contentType={f.contentType}
                  versionId={f.versionId}
                  hasThumb={f.hasThumb}
                  className="size-9"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{f.name}</span>
                  <span className="num block truncate text-[12px] text-muted">
                    {formatFileSize(f.sizeBytes)}
                    {f.folderName ? ` · ${f.folderName}` : ""}
                  </span>
                </span>
              </button>
              {canWork && (
                <button
                  type="button"
                  onClick={() =>
                    detach.mutate({ projectId, taskId, fileId: f.id })
                  }
                  className="rounded-control p-2 text-muted hover:bg-sunken hover:text-text"
                  aria-label={`Detach ${f.name}`}
                >
                  <IconClose size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {(list.data?.hidden ?? 0) > 0 && (
        <p className="mt-2 text-[12px] text-muted">
          Plus {list.data!.hidden} restricted file
          {list.data!.hidden === 1 ? "" : "s"}.
        </p>
      )}
      {open && (
        <FileSheet
          projectId={projectId}
          fileId={open}
          folders={visibleFolders}
          onClose={() => setOpen(null)}
        />
      )}
      {picking && (
        <PickFromFiles
          projectId={projectId}
          taskId={taskId}
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  );
}

function PickFromFiles({
  projectId,
  taskId,
  onClose,
}: {
  projectId: string;
  taskId: string;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const toast = useToast();
  const folders = useQuery(trpc.files.folders.queryOptions({ projectId }));
  const [folderId, setFolderId] = useState("");
  const current =
    folderId ||
    folders.data?.folders.find((f) => f.files > 0)?.id ||
    folders.data?.folders[0]?.id ||
    "";
  const files = useQuery({
    ...trpc.files.list.queryOptions({ projectId, folderId: current }),
    enabled: !!current,
  });
  const invalidate = useInvalidateFiles(projectId);
  const attach = useMutation(
    trpc.files.attach.mutationOptions({
      onSuccess: async () => {
        toast("success", "Attached");
        await invalidate();
        onClose();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  return (
    <Dialog open onClose={onClose} title="Attach from Files">
      <div className="flex flex-col gap-4">
        <Field label="Folder" htmlFor="pf-folder">
          <Select
            id="pf-folder"
            value={current}
            onChange={(e) => setFolderId(e.target.value)}
          >
            {(folders.data?.folders ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({f.files})
              </option>
            ))}
          </Select>
        </Field>
        {files.isPending ? (
          <Skeleton className="h-24 rounded-panel" />
        ) : !files.data?.length ? (
          <p className="text-sm text-muted">No files in this folder.</p>
        ) : (
          <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-panel border border-border">
            {files.data.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  disabled={attach.isPending}
                  onClick={() =>
                    attach.mutate({ projectId, taskId, fileId: f.id })
                  }
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-sunken/60"
                >
                  <FileIcon
                    name={f.name}
                    contentType={f.contentType}
                    versionId={f.versionId}
                    hasThumb={f.hasThumb}
                    className="size-9"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {f.name}
                  </span>
                  <span className="num shrink-0 text-[12px] text-muted">
                    {formatFileSize(f.sizeBytes)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
