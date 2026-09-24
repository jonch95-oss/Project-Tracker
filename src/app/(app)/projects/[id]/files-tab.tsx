"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconArrowLeft, IconBell, IconChevronRight, IconLock, IconPaperclip, IconPlus, IconTeam } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Badge, Button, Field, Input, Select, Skeleton, StatusPill } from "@/components/ui/primitives";
import { fileExtension, formatFileSize, TRASH_DAYS } from "@/core/files";
import { formatDateTimeET } from "@/core/time";
import { cn } from "@/lib/cn";
import { fileUrl, largeFiles, useFileUpload, type UploadItem } from "@/lib/file-upload";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";

type Folders = RouterOutputs["files"]["folders"];
type Folder = Folders["folders"][number];
type FileItem = RouterOutputs["files"]["list"][number];

export function useInvalidateFiles(projectId: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.files.folders.queryKey({ projectId }) }),
      qc.invalidateQueries({ queryKey: trpc.files.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.files.get.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.files.forTask.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.files.trash.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.checklist.get.queryKey() }),
    ]);
}

/** Files (brief §14): folders, uploads with versions, previews, the gated Financial folder, sharing with outside parties. */
export function FilesTab({ projectId, onOpenPhotos, focusFolder, focusFile }: { projectId: string; onOpenPhotos: () => void; focusFolder?: string | null; focusFile?: string | null }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.files.folders.queryOptions({ projectId }));
  const canShare = q.data?.access.canShare ?? false;
  const m = useQuery({ ...trpc.members.list.queryOptions({ projectId }), enabled: canShare });
  const members = (m.data ?? []).map((x) => ({ id: x.userId, name: x.name, external: x.globalRole === "external" || x.globalRole === "investor" }));
  // A link from a notification opens its folder (and file) directly.
  const [open, setOpen] = useState<string | null>(focusFolder ?? null);
  const [dialog, setDialog] = useState<null | "newFolder" | "trash">(null);

  if (q.isPending) return <Skeleton className="h-80 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const { folders, access } = q.data;
  if (folders.length === 0) return <EmptyState title="No folders shared with you yet" body="When the project team shares a folder with you, its files appear here." />;
  const current = folders.find((f) => f.id === open) ?? null;

  return (
    <section aria-labelledby="files-h">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <h2 id="files-h" className="serif text-heading">
          Files
        </h2>
        <div className="flex flex-wrap gap-2">
          {access.canManageAll && (
            <Button variant="ghost" size="sm" onClick={() => setDialog("trash")}>
              Trash
            </Button>
          )}
          {access.canEditFolders && (
            <Button variant="secondary" size="sm" onClick={() => setDialog("newFolder")}>
              <IconPlus size={16} /> Folder
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <nav aria-label="Folders" className={cn(current && "hidden lg:block")}>
          <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
            {folders.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => setOpen(f.id)}
                  aria-current={f.id === open ? "true" : undefined}
                  className={cn("flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left hover:bg-sunken/60", f.id === open && "bg-sunken")}
                >
                  <FolderGlyph gated={f.gated} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{f.name}</span>
                    <span className="num block text-[12px] text-muted">
                      {f.files} {f.files === 1 ? "file" : "files"}
                      {f.isPhotos && f.photos ? ` · ${f.photos} site photos` : ""}
                      {f.sharedWith.length ? ` · shared with ${f.sharedWith.length}` : ""}
                    </span>
                  </span>
                  <IconChevronRight size={16} className="text-faint lg:hidden" />
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className={cn(!current && "hidden lg:block")}>
          {current ? (
            <FolderView key={current.id} projectId={projectId} folder={current} initialFile={current.id === focusFolder ? (focusFile ?? null) : null} folders={folders} access={access} members={members} onBack={() => setOpen(null)} onOpenPhotos={onOpenPhotos} />
          ) : (
            <div className="flex h-full min-h-48 items-center justify-center rounded-card border border-dashed border-border p-8 text-center text-sm text-muted">Pick a folder.</div>
          )}
        </div>
      </div>
      {dialog === "newFolder" && <NewFolderDialog projectId={projectId} onClose={() => setDialog(null)} />}
      {dialog === "trash" && <TrashDialog projectId={projectId} canPurge={access.canPurge} onClose={() => setDialog(null)} />}
    </section>
  );
}

function FolderGlyph({ gated }: { gated: boolean }) {
  return (
    <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-control border", gated ? "border-attention/40 bg-attention-tint text-attention-text" : "border-border bg-sunken text-muted")}>
      {gated ? (
        <IconLock size={16} />
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M3.5 6.5h6l2 2h9v10h-17z" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

function FolderView({
  projectId,
  folder: f,
  folders,
  access,
  members,
  onBack,
  onOpenPhotos,
  initialFile,
}: {
  projectId: string;
  initialFile: string | null;
  folder: Folder;
  folders: Folder[];
  access: Folders["access"];
  members: { id: string; name: string; external: boolean }[];
  onBack: () => void;
  onOpenPhotos: () => void;
}) {
  const trpc = useTRPC();
  const toast = useToast();
  const q = useQuery(trpc.files.list.queryOptions({ projectId, folderId: f.id }));
  const invalidate = useInvalidateFiles(projectId);
  const up = useFileUpload(projectId);
  const [openFile, setOpenFile] = useState<string | null>(initialFile);
  const watch = useMutation(
    trpc.files.watchFolder.mutationOptions({
      onSuccess: (r) => {
        toast("success", r.watching ? `You'll hear when files are added to ${f.name}` : `Stopped watching ${f.name}`);
        return invalidate();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const [confirmLarge, setConfirmLarge] = useState<File[] | null>(null);
  const [dialog, setDialog] = useState<null | "rename" | "share" | "delete">(null);
  const input = useRef<HTMLInputElement>(null);

  const start = async (files: File[]) => {
    const r = await up.upload(files, { folderId: f.id });
    if (r.ok) toast("success", r.ok === 1 ? "File added" : `${r.ok} files added`);
    if (r.failed) toast("error", `${r.failed} upload${r.failed === 1 ? "" : "s"} didn't finish`);
    await invalidate();
  };
  const pick = (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (input.current) input.current.value = "";
    if (!files.length) return;
    if (largeFiles(files).length) setConfirmLarge(files);
    else void start(files);
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="lg:hidden" aria-label="All folders">
          <IconArrowLeft size={16} /> Folders
        </Button>
        <h3 className="flex min-w-0 flex-1 items-center gap-2 text-[17px] font-medium">
          <span className="truncate">{f.name}</span>
          {f.gated && <StatusPill tone="attention">Financial — restricted</StatusPill>}
        </h3>
        <div className="flex flex-wrap gap-2">
          {!f.isPhotos && (
            <Button variant="ghost" size="sm" aria-pressed={f.watching} loading={watch.isPending} onClick={() => watch.mutate({ projectId, folderId: f.id, on: !f.watching })}>
              <IconBell size={16} /> {f.watching ? "Watching" : "Watch"}
            </Button>
          )}
          {access.canShare && members.some((m) => m.external) && (
            <Button variant="ghost" size="sm" onClick={() => setDialog("share")}>
              <IconTeam size={16} /> Share
            </Button>
          )}
          {access.canEditFolders && (
            <Button variant="ghost" size="sm" onClick={() => setDialog("rename")}>
              Rename
            </Button>
          )}
          {access.canEditFolders && !f.gated && !f.isPhotos && (
            <Button variant="ghost" size="sm" onClick={() => setDialog("delete")}>
              Remove
            </Button>
          )}
          <Button size="sm" onClick={() => input.current?.click()} disabled={up.busy}>
            <IconPlus size={16} /> Upload
          </Button>
          <input ref={input} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => pick(e.target.files)} />
        </div>
      </div>

      <DropZone onFiles={pick} disabled={up.busy}>
        {f.isPhotos && f.photos > 0 && (
          <button type="button" onClick={onOpenPhotos} className="mb-3 w-full rounded-panel bg-sunken px-4 py-3 text-left text-[13px] text-muted hover:text-text">
            {f.photos} site photo{f.photos === 1 ? "" : "s"} live on the Overview tab →
          </button>
        )}
        <UploadQueue items={up.items} onClear={up.clear} />
        {q.isPending ? (
          <Skeleton className="h-40 rounded-card" />
        ) : q.isError ? (
          <ErrorState onRetry={() => q.refetch()} />
        ) : q.data.length === 0 ? (
          <div className="rounded-card border border-dashed border-border px-6 py-10 text-center text-sm text-muted">
            Nothing here yet. <span className="hidden sm:inline">Drop files here or </span>
            <button type="button" className="underline underline-offset-4 hover:text-text" onClick={() => input.current?.click()}>
              upload
            </button>
            .
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
            {q.data.map((file) => (
              <FileRowItem key={file.id} file={file} onOpen={() => setOpenFile(file.id)} />
            ))}
          </ul>
        )}
      </DropZone>

      {openFile && <FileSheet projectId={projectId} fileId={openFile} folders={folders} onClose={() => setOpenFile(null)} />}
      <ConfirmDialog
        open={!!confirmLarge}
        title="Large file"
        body={`${largeFiles(confirmLarge ?? [])
          .map((x) => `${x.name} (${formatFileSize(x.size)})`)
          .join(", ")} ${largeFiles(confirmLarge ?? []).length === 1 ? "is" : "are"} over 100 MB. All project files share 10 GB of storage — upload anyway?`}
        confirmLabel="Upload"
        onCancel={() => setConfirmLarge(null)}
        onConfirm={() => {
          const files = confirmLarge!;
          setConfirmLarge(null);
          void start(files);
        }}
      />
      {dialog === "rename" && <RenameFolderDialog projectId={projectId} folder={f} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteFolderDialog projectId={projectId} folder={f} onClose={() => setDialog(null)} onDeleted={onBack} />}
      {dialog === "share" && <ShareFolderDialog projectId={projectId} folder={f} members={members.filter((m) => m.external)} onClose={() => setDialog(null)} />}
    </div>
  );
}

function DropZone({ onFiles, disabled, children }: { onFiles: (f: FileList | null) => void; disabled: boolean; children: ReactNode }) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    // A file dropped anywhere else on the page must not navigate away (and kill uploads).
    const stop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);
  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        // Always claim the drop, so the browser never opens the file and leaves the app.
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) onFiles(e.dataTransfer.files);
      }}
      className={cn("rounded-card transition-shadow", over && "shadow-[0_0_0_2px_var(--accent)]")}
    >
      {children}
    </div>
  );
}

export function UploadQueue({ items, onClear }: { items: UploadItem[]; onClear: () => void }) {
  if (items.length === 0) return null;
  const finished = items.every((i) => i.state !== "uploading");
  return (
    <div className="mb-3 rounded-panel border border-border bg-surface p-3" aria-live="polite">
      <ul className="flex flex-col gap-2">
        {items.map((i) => (
          <li key={i.key} className="text-[13px]">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">{i.name}</span>
              <span className={cn("num shrink-0", i.state === "error" ? "text-blocked-text" : "text-muted")}>
                {i.state === "done" ? "Done" : i.state === "error" ? "Failed" : `${Math.round(i.progress * 100)}%`}
              </span>
            </div>
            {i.state === "uploading" && (
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label={`Uploading ${i.name}`} aria-valuenow={Math.round(i.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.max(2, i.progress * 100)}%` }} />
              </div>
            )}
            {i.error && <p className="mt-0.5 text-[12px] text-blocked-text">{i.error}</p>}
          </li>
        ))}
      </ul>
      {finished && (
        <button type="button" onClick={onClear} className="mt-2 text-[12px] text-muted underline underline-offset-4">
          Clear
        </button>
      )}
    </div>
  );
}

export function FileIcon({ name, contentType, versionId, hasThumb, className }: { name: string; contentType: string; versionId: string; hasThumb: boolean; className?: string }) {
  if (hasThumb) {
    // eslint-disable-next-line @next/next/no-img-element -- private, access-checked route
    return <img src={fileUrl(versionId, { thumb: true })} alt="" loading="lazy" className={cn("size-10 shrink-0 rounded-control border border-border object-cover", className)} />;
  }
  const ext = (fileExtension(name) || contentType.split("/")[1] || "file").slice(0, 4).toUpperCase();
  return <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-control border border-border bg-sunken text-[10px] font-medium tracking-wide text-muted", className)}>{ext}</span>;
}

function FileRowItem({ file, onOpen }: { file: FileItem; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-sunken/60">
        <FileIcon name={file.name} contentType={file.contentType} versionId={file.versionId} hasThumb={file.hasThumb} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px]">{file.name}</span>
          <span className="num block truncate text-[12px] text-muted">
            {formatFileSize(file.sizeBytes)} · {file.uploadedByName ?? "Former teammate"} · {formatDateTimeET(file.uploadedAt, { month: "short", day: "numeric" })}
          </span>
        </span>
        {file.currentVersion > 1 && <Badge>v{file.currentVersion}</Badge>}
      </button>
    </li>
  );
}

/** One file: preview, versions (each downloadable), new version, rename, move, remove, and the tasks it's on. */
export function FileSheet({ projectId, fileId, folders, onClose }: { projectId: string; fileId: string; folders: Folder[]; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const q = useQuery(trpc.files.get.queryOptions({ projectId, fileId }));
  const invalidate = useInvalidateFiles(projectId);
  const up = useFileUpload(projectId);
  const input = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const rename = useMutation(trpc.files.rename.mutationOptions({ onSuccess: () => setRenaming(false), onError, onSettled: invalidate }));
  const move = useMutation(trpc.files.move.mutationOptions({ onSuccess: () => toast("success", "Moved"), onError, onSettled: invalidate }));
  const remove = useMutation(
    trpc.files.remove.mutationOptions({
      onSuccess: async () => {
        toast("success", `Moved to the trash. It's kept ${TRASH_DAYS} days.`);
        await invalidate();
        onClose();
      },
      onError,
    }),
  );

  const d = q.data;
  const cur = d?.versions[0];
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={d?.name ?? "File"}
      description={d ? <>{d.folder ? d.folder.name : "Attached to a task"} · version {d.currentVersion}</> : undefined}
      footer={
        d && cur ? (
          <>
            {d.access.canManage && (
              <Button variant="danger" className="mr-auto" onClick={() => setConfirmRemove(true)}>
                Remove
              </Button>
            )}
            <a href={fileUrl(cur.id)} target="_blank" rel="noopener" className="inline-flex h-11 items-center justify-center rounded-control bg-primary px-5 text-sm font-medium text-on-primary">
              Open
            </a>
          </>
        ) : null
      }
    >
      {q.isPending ? (
        <Skeleton className="h-64 rounded-panel" />
      ) : q.isError || !d || !cur ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          <Preview versionId={cur.id} kind={cur.preview} name={d.name} />

          {d.access.canManage && (
            <div className="grid gap-4 sm:grid-cols-2">
              {renaming ? (
                <form
                  className="flex gap-2 sm:col-span-2"
                  onSubmit={(e: FormEvent<HTMLFormElement>) => {
                    e.preventDefault();
                    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
                    if (name) rename.mutate({ projectId, fileId, version: d.version, name });
                  }}
                >
                  <label htmlFor="fs-name" className="sr-only">
                    File name
                  </label>
                  <Input id="fs-name" name="name" defaultValue={d.name} maxLength={200} autoFocus className="h-10 flex-1" />
                  <Button type="submit" size="sm" loading={rename.isPending}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setRenaming(true)} className="justify-self-start">
                  Rename
                </Button>
              )}
              {d.folder && folders.length > 1 && (
                <Field label="Folder" htmlFor="fs-move">
                  <Select id="fs-move" value={d.folder.id} onChange={(e) => move.mutate({ projectId, fileId, version: d.version, folderId: e.target.value })}>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
          )}

          {d.tasks.length > 0 && (
            <section>
              <h3 className="mb-2 text-[13px] font-medium">On tasks</h3>
              <ul className="flex flex-wrap gap-2">
                {d.tasks.map((t) => (
                  <li key={t.id}>
                    <a href={`/projects/${projectId}?tab=checklist&task=${t.id}`} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[13px] hover:bg-sunken">
                      <IconPaperclip size={12} /> {t.title}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="fs-versions-h">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 id="fs-versions-h" className="text-[13px] font-medium">
                Versions
              </h3>
              {d.access.canAddVersion && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => input.current?.click()} loading={up.busy}>
                    <IconPlus size={16} /> New version
                  </Button>
                  <input
                    ref={input}
                    type="file"
                    className="sr-only"
                    tabIndex={-1}
                    aria-hidden="true"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      if (largeFiles([file]).length && !window.confirm(`${file.name} is ${formatFileSize(file.size)}. All project files share 10 GB of storage — upload anyway?`)) return;
                      const r = await up.upload([file], { fileId });
                      if (r.ok) toast("success", "New version uploaded");
                      await invalidate();
                    }}
                  />
                </>
              )}
            </div>
            <UploadQueue items={up.items} onClear={up.clear} />
            <ol className="divide-y divide-border rounded-panel border border-border">
              {d.versions.map((v) => (
                <li key={v.id} className="flex items-center gap-3 px-3 py-2.5 text-[13px]">
                  <span className="num w-8 shrink-0 font-medium">v{v.number}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{v.originalName}</span>
                    <span className="num block truncate text-muted">
                      {formatFileSize(v.sizeBytes)} · {v.uploadedByName ?? "Former teammate"} · {formatDateTimeET(v.createdAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      {v.scanStatus === "clean" ? " · scanned" : ""}
                    </span>
                  </span>
                  <a href={fileUrl(v.id)} target="_blank" rel="noopener" className="shrink-0 underline underline-offset-4">
                    Open
                  </a>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
      <ConfirmDialog
        open={confirmRemove}
        title="Move to the trash?"
        body={`It disappears from Files and from any task it's on. It stays in the trash for ${TRASH_DAYS} days; restoring it puts it back everywhere.`}
        confirmLabel="Move to trash"
        danger
        busy={remove.isPending}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => remove.mutate({ projectId, fileId })}
      />
    </Dialog>
  );
}

function Preview({ versionId, kind, name }: { versionId: string; kind: "image" | "pdf" | "none"; name: string }) {
  if (kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element -- private, access-checked route
    return <img src={fileUrl(versionId)} alt={name} className="max-h-[60vh] w-full rounded-panel border border-border bg-sunken object-contain" />;
  }
  if (kind === "pdf") {
    return (
      <div>
        <iframe src={fileUrl(versionId)} title={`Preview of ${name}`} className="h-[50vh] w-full rounded-panel border border-border bg-sunken sm:h-[60vh]" />
        <p className="mt-2 text-[13px] text-muted sm:hidden">On a phone the preview may show the first page only. Tap Open for the whole PDF.</p>
      </div>
    );
  }
  return <p className="rounded-panel bg-sunken px-4 py-6 text-center text-[13px] text-muted">No preview for this kind of file. Open it to download.</p>;
}

function NewFolderDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const invalidate = useInvalidateFiles(projectId);
  const create = useMutation(
    trpc.files.createFolder.mutationOptions({
      onSuccess: async () => {
        await invalidate();
        onClose();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="New folder"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="nf-form" loading={create.isPending}>
            Add folder
          </Button>
        </>
      }
    >
      <form
        id="nf-form"
        onSubmit={(e) => {
          e.preventDefault();
          const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
          if (name) create.mutate({ projectId, name });
        }}
      >
        <Field label="Name" htmlFor="nf-name">
          <Input id="nf-name" name="name" required maxLength={80} autoFocus />
        </Field>
      </form>
    </Dialog>
  );
}

function RenameFolderDialog({ projectId, folder, onClose }: { projectId: string; folder: Folder; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const invalidate = useInvalidateFiles(projectId);
  const rename = useMutation(
    trpc.files.renameFolder.mutationOptions({
      onSuccess: async () => {
        await invalidate();
        onClose();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Rename ${folder.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="rf-form" loading={rename.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="rf-form"
        onSubmit={(e) => {
          e.preventDefault();
          const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
          if (name) rename.mutate({ projectId, folderId: folder.id, name });
        }}
      >
        <Field label="Name" htmlFor="rf-name">
          <Input id="rf-name" name="name" required maxLength={80} defaultValue={folder.name} autoFocus />
        </Field>
      </form>
    </Dialog>
  );
}

function DeleteFolderDialog({ projectId, folder, onClose, onDeleted }: { projectId: string; folder: Folder; onClose: () => void; onDeleted: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const invalidate = useInvalidateFiles(projectId);
  const del = useMutation(
    trpc.files.deleteFolder.mutationOptions({
      onSuccess: async () => {
        await invalidate();
        onDeleted();
        onClose();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  return (
    <ConfirmDialog
      open
      title={`Remove ${folder.name}?`}
      body="Only empty folders can be removed."
      confirmLabel="Remove folder"
      danger
      busy={del.isPending}
      onCancel={onClose}
      onConfirm={() => del.mutate({ projectId, folderId: folder.id })}
    />
  );
}

function ShareFolderDialog({ projectId, folder, members, onClose }: { projectId: string; folder: Folder; members: { id: string; name: string }[]; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const invalidate = useInvalidateFiles(projectId);
  const share = useMutation(trpc.files.shareFolder.mutationOptions({ onError: (e) => toast("error", errorMessage(e)), onSettled: invalidate }));
  return (
    <Dialog open onClose={onClose} title={`Share ${folder.name}`} description="Outside collaborators on this project see only the folders shared with them. The internal team sees every folder.">
      {members.length === 0 ? (
        <p className="text-sm text-muted">No outside collaborators on this project.</p>
      ) : (
        <ul className="flex flex-col">
          {members.map((m) => {
            const on = folder.sharedWith.includes(m.id);
            return (
              <li key={m.id} className="flex min-h-12 items-center justify-between gap-3">
                <span className="text-sm">{m.name}</span>
                <Button size="sm" variant={on ? "secondary" : "ghost"} loading={share.isPending && share.variables?.userId === m.id} onClick={() => share.mutate({ projectId, folderId: folder.id, userId: m.id, on: !on })} aria-pressed={on}>
                  {on ? "Shared" : "Share"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

function TrashDialog({ projectId, canPurge, onClose }: { projectId: string; canPurge: boolean; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const q = useQuery(trpc.files.trash.queryOptions({ projectId }));
  const invalidate = useInvalidateFiles(projectId);
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const restore = useMutation(trpc.files.restore.mutationOptions({ onSuccess: () => toast("success", "Restored"), onError, onSettled: invalidate }));
  const purge = useMutation(trpc.files.purge.mutationOptions({ onSuccess: () => toast("success", "Deleted for good"), onError, onSettled: invalidate }));
  const [confirmPurge, setConfirmPurge] = useState<{ id: string; name: string } | null>(null);
  return (
    <Dialog open onClose={onClose} size="lg" title="Trash" description={`Removed files are kept ${TRASH_DAYS} days, then deleted for good.`}>
      {q.isPending ? (
        <Skeleton className="h-32 rounded-panel" />
      ) : !q.data?.length ? (
        <p className="text-sm text-muted">The trash is empty.</p>
      ) : (
        <ul className="divide-y divide-border">
          {q.data.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-3 py-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{f.name}</span>
                <span className="num block text-[12px] text-muted">
                  {f.folderName} · {formatFileSize(f.sizeBytes)} · removed {f.deletedAt ? formatDateTimeET(f.deletedAt, { month: "short", day: "numeric" }) : ""}
                </span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => restore.mutate({ projectId, fileId: f.id })}>
                Restore
              </Button>
              {canPurge && (
                <Button size="sm" variant="ghost" onClick={() => setConfirmPurge({ id: f.id, name: f.name })}>
                  Delete now
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!confirmPurge}
        title={`Delete ${confirmPurge?.name ?? "this file"} for good?`}
        body="Every version is deleted permanently. This can't be undone."
        confirmLabel="Delete for good"
        danger
        busy={purge.isPending}
        onCancel={() => setConfirmPurge(null)}
        onConfirm={() => {
          purge.mutate({ projectId, fileId: confirmPurge!.id });
          setConfirmPurge(null);
        }}
      />
      <ConfirmDialog
        open={!!confirmPurge}
        title={`Delete ${confirmPurge?.name ?? "this file"} for good?`}
        body="Every version is deleted permanently. This can't be undone."
        confirmLabel="Delete for good"
        danger
        busy={purge.isPending}
        onCancel={() => setConfirmPurge(null)}
        onConfirm={() => {
          purge.mutate({ projectId, fileId: confirmPurge!.id });
          setConfirmPurge(null);
        }}
      />
    </Dialog>
  );
}
