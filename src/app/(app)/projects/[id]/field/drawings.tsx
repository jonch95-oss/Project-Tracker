"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconArrowLeft, IconPlus } from "@/components/ui/icons";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Input, Select, Skeleton, StatusPill } from "@/components/ui/primitives";
import { DISCIPLINES } from "@/core/field";
import { formatIsoDate, todayET } from "@/core/time";
import { cn } from "@/lib/cn";
import { useFileUpload } from "@/lib/file-upload";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";
import { PunchDialog, type PunchDraft } from "./punch";

type Sets = RouterOutputs["drawings"]["list"]["sets"];

const disciplineLabel = (k: string) => DISCIPLINES.find((d) => d.key === k)?.label ?? k;

/** Module F: "What's current" (one current set per discipline), superseded sets as history, and the sheet viewer. */
export function DrawingsView({ projectId, sheetId, onSheet }: { projectId: string; sheetId: string | null; onSheet: (id: string | null) => void }) {
  if (sheetId) return <SheetViewer projectId={projectId} sheetId={sheetId} onBack={() => onSheet(null)} />;
  return <DrawingIndex projectId={projectId} onSheet={onSheet} />;
}

function DrawingIndex({ projectId, onSheet }: { projectId: string; onSheet: (id: string) => void }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.drawings.list.queryOptions({ projectId }));
  const [uploading, setUploading] = useState(false);
  const [history, setHistory] = useState(false);
  if (q.isPending) return <Skeleton className="h-80 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const current = q.data.sets.filter((s) => s.current);
  const old = q.data.sets.filter((s) => !s.current);
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="serif text-heading">What&apos;s current</h2>
          <p className="mt-1 text-[13px] text-muted">One current set per discipline. Anything older is stamped superseded.</p>
        </div>
        {q.data.canEdit && (
          <Button size="sm" onClick={() => setUploading(true)}>
            <IconPlus size={16} /> Issue a set
          </Button>
        )}
      </div>
      {current.length === 0 ? <EmptyState title="No drawings yet" body={q.data.canEdit ? "Issue a set: upload the PDFs for one discipline and they become the current sheets." : "Drawings shared with you show here."} /> : <SetList sets={current} onSheet={onSheet} />}
      {old.length > 0 && (
        <div className="mt-8">
          <button type="button" className="text-[13px] text-muted underline underline-offset-4" aria-expanded={history} onClick={() => setHistory((h) => !h)}>
            {history ? "Hide" : "Show"} superseded sets ({old.length})
          </button>
          {history && (
            <div className="mt-4 opacity-80">
              <SetList sets={old} onSheet={onSheet} />
            </div>
          )}
        </div>
      )}
      {uploading && <IssueSetDialog projectId={projectId} onClose={() => setUploading(false)} />}
    </div>
  );
}

function SetList({ sets, onSheet }: { sets: Sets; onSheet: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-6">
      {sets.map((s) => (
        <section key={s.id} aria-label={`${disciplineLabel(s.discipline)}: ${s.name}`}>
          <h3 className="mb-2 flex flex-wrap items-baseline gap-2 text-[15px] font-medium">
            <span className="num rounded-control bg-sunken px-1.5 text-[12px]">{s.discipline}</span>
            {disciplineLabel(s.discipline)} · {s.name}
            {s.issuedOn && <span className="num text-[13px] font-normal text-muted">issued {formatIsoDate(s.issuedOn, { month: "short", day: "numeric", year: "numeric" })}</span>}
            {!s.current && <StatusPill tone="blocked">Superseded</StatusPill>}
          </h3>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {s.sheets.map((sh) => (
              <li key={sh.id}>
                <button type="button" onClick={() => onSheet(sh.id)} className="flex w-full items-center justify-between gap-3 rounded-panel border border-border bg-surface px-4 py-3 text-left hover:border-text/30">
                  <span className="min-w-0">
                    <span className="num block text-[15px] font-medium">{sh.number}</span>
                    <span className="block truncate text-[12px] text-muted">{sh.title}</span>
                  </span>
                  {sh.openPunch > 0 && <span className="num shrink-0 rounded-full bg-attention-tint px-2 text-[12px] text-attention-text">{sh.openPunch} punch</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function IssueSetDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const folders = useQuery(trpc.files.folders.queryOptions({ projectId }));
  const up = useFileUpload(projectId);
  const [files, setFiles] = useState<File[]>([]);
  const create = useMutation(trpc.drawings.createSet.mutationOptions({ onError: (e) => toast("error", errorMessage(e)) }));
  const folderId = folders.data?.folders.find((f) => f.name === "Drawings")?.id ?? folders.data?.folders.find((f) => f.name === "Design")?.id ?? folders.data?.folders.find((f) => !f.gated && !f.isPhotos)?.id;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (!folderId) return toast("error", "There's no folder to keep the drawings in.");
    const pdfs = files.filter((x) => /\.pdf$/i.test(x.name));
    if (pdfs.length === 0) return toast("error", "Choose the sheet PDFs.");
    const ids: string[] = [];
    for (const file of pdfs) {
      const r = await up.upload([file], { folderId });
      if (r.lastFileId) ids.push(r.lastFileId);
    }
    if (ids.length === 0) return;
    await create.mutateAsync({ projectId, discipline: String(f.get("discipline")) as never, name: String(f.get("name")).trim(), issuedOn: String(f.get("issued") || "") || null, fileIds: ids });
    toast("success", `Set issued: ${ids.length} sheet${ids.length === 1 ? "" : "s"}`);
    await qc.invalidateQueries({ queryKey: trpc.drawings.list.queryKey({ projectId }) });
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Issue a drawing set"
      description="The discipline's current set becomes superseded. Name each PDF by sheet (e.g. A-101 Floor Plans.pdf)."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="set-form" loading={up.busy || create.isPending}>
            Issue set
          </Button>
        </>
      }
    >
      <form id="set-form" onSubmit={submit} className="grid gap-5 sm:grid-cols-2">
        <Field label="Discipline" htmlFor="set-disc">
          <Select id="set-disc" name="discipline" defaultValue="A">
            {DISCIPLINES.map((d) => (
              <option key={d.key} value={d.key}>
                {d.key}: {d.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Issued" htmlFor="set-issued">
          <Input id="set-issued" name="issued" type="date" defaultValue={todayET()} className="num" />
        </Field>
        <Field label="Set name" htmlFor="set-name" className="sm:col-span-2">
          <Input id="set-name" name="name" required maxLength={120} placeholder="e.g. Permit set rev 2" />
        </Field>
        <Field label="Sheet PDFs" htmlFor="set-files" className="sm:col-span-2" hint={files.length ? `${files.length} chosen` : undefined}>
          <input id="set-files" type="file" accept="application/pdf,.pdf" multiple required onChange={(e) => setFiles([...(e.target.files ?? [])])} className="text-sm" />
        </Field>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Sheet viewer: PDF.js, a SUPERSEDED stamp, and punch pins             */
/* ------------------------------------------------------------------ */

type PdfDoc = { numPages: number; getPage: (n: number) => Promise<{ getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas: HTMLCanvasElement }) => { promise: Promise<void>; cancel: () => void } }> };
type PdfTask = { promise: Promise<PdfDoc>; destroy: () => Promise<void> };

/** Starts loading a sheet; destroy the returned task (pdfjs 6 has no destroy on the document) to free it. */
async function loadPdf(url: string): Promise<PdfTask> {
  // The legacy build runs on older iPhone Safari too.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!pdfjs.GlobalWorkerOptions.workerPort) {
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
  }
  return pdfjs.getDocument({ url }) as unknown as PdfTask;
}

const MAX_CANVAS_PIXELS = 16_000_000;

function SheetViewer({ projectId, sheetId, onBack }: { projectId: string; sheetId: string; onBack: () => void }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.drawings.sheet.queryOptions({ projectId, sheetId }));
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [pinMode, setPinMode] = useState(false);
  const [draft, setDraft] = useState<PunchDraft | null>(null);
  const versionId = q.data?.versionId;

  useEffect(() => {
    if (!versionId) return;
    let live = true;
    let task: PdfTask | null = null;
    (async () => {
      try {
        const { url } = (await (await fetch(`/api/media/files/${versionId}?sign=1`)).json()) as { url: string };
        if (!live) return;
        task = await loadPdf(url);
        if (!live) return void task.destroy().catch(() => {});
        const loaded = await task.promise;
        if (live) setDoc(loaded);
      } catch {
        if (live) setError("This sheet couldn't be opened here.");
      }
    })();
    return () => {
      live = false;
      if (task) void task.destroy().catch(() => {});
    };
  }, [versionId]);

  useEffect(() => {
    if (!doc || !canvas.current || !box.current) return;
    let task: { cancel: () => void } | null = null;
    let live = true;
    (async () => {
      const p = await doc.getPage(page);
      const base = p.getViewport({ scale: 1 });
      const width = box.current!.clientWidth * zoom;
      const scale = width / base.width;
      // iOS Safari draws nothing on a canvas over ~16.7M pixels; past that, render at the cap and let CSS stretch it.
      const dpr = window.devicePixelRatio || 1;
      const wanted = scale * dpr;
      const cap = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
      const vp = p.getViewport({ scale: Math.min(wanted, cap) });
      const c = canvas.current!;
      c.width = vp.width;
      c.height = vp.height;
      c.style.width = `${width}px`;
      c.style.height = `${(base.height * width) / base.width}px`;
      const r = p.render({ canvasContext: c.getContext("2d")!, viewport: vp, canvas: c });
      task = r;
      await r.promise.catch(() => undefined);
      if (live) setSize({ w: width, h: (base.height * width) / base.width });
    })();
    return () => {
      live = false;
      task?.cancel();
    };
  }, [doc, page, zoom]);

  if (q.isPending) return <Skeleton className="h-[70vh] rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const { sheet, set, superseded, pins, canPin } = q.data;
  const onTap = (e: MouseEvent<HTMLDivElement>) => {
    // A tap works as soon as the sheet is on screen, even while a big PDF is still drawing.
    if (!pinMode) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDraft({ sheetId: sheet.id, page, x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height });
    setPinMode(false);
  };
  const pagePins = pins.filter((p) => p.page === page && p.x !== null && p.y !== null);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <IconArrowLeft size={16} /> Drawings
        </Button>
        <h2 className="num min-w-0 flex-1 truncate text-[17px] font-medium">
          {sheet.number} <span className="font-normal text-muted">· {sheet.title} · {set.name}</span>
        </h2>
        {superseded && <StatusPill tone="blocked">Superseded</StatusPill>}
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setZoom((z) => Math.max(1, z - 0.5))} disabled={zoom <= 1} aria-label="Zoom out">
            −
          </Button>
          <span className="num w-10 text-center text-[13px]">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="sm" onClick={() => setZoom((z) => Math.min(4, z + 0.5))} aria-label="Zoom in">
            +
          </Button>
        </div>
        {doc && doc.numPages > 1 && (
          <span className="flex items-center gap-1 text-[13px]">
            <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
              ‹
            </Button>
            <span className="num">
              {page}/{doc.numPages}
            </span>
            <Button variant="ghost" size="sm" disabled={page >= doc.numPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
              ›
            </Button>
          </span>
        )}
        {canPin && !superseded && (
          <Button size="sm" variant={pinMode ? "primary" : "secondary"} aria-pressed={pinMode} onClick={() => setPinMode((m) => !m)}>
            {pinMode ? "Tap the drawing…" : "Drop a punch pin"}
          </Button>
        )}
      </div>
      {superseded && <p className="mb-3 rounded-panel bg-blocked-tint px-4 py-2 text-[13px] text-blocked-text">This sheet has been superseded by a newer set. Use &ldquo;What&apos;s current&rdquo; for the field.</p>}
      <div ref={box} className="overflow-auto rounded-card border border-border bg-white" style={{ maxHeight: "75vh" }}>
        {error ? (
          <p className="p-8 text-center text-sm text-muted">
            {error}{" "}
            <a className="underline underline-offset-4" href={`/api/media/files/${versionId}`} target="_blank" rel="noopener noreferrer">
              Open the PDF
            </a>
          </p>
        ) : (
          <div className={cn("relative inline-block", pinMode && "cursor-crosshair")} onClick={onTap}>
            <canvas ref={canvas} aria-label={`Sheet ${sheet.number}`} role="img" />
            {!doc && <Skeleton className="absolute inset-0" />}
            {superseded && size && (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
                <span className="rotate-[-24deg] rounded border-4 border-blocked/70 px-6 py-2 text-[clamp(28px,8vw,96px)] font-bold tracking-widest text-blocked/60">SUPERSEDED</span>
              </span>
            )}
            {size &&
              pagePins.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDraft({ sheetId: sheet.id, page: p.page, x: p.x!, y: p.y!, item: p });
                  }}
                  className={cn("num absolute flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white text-[11px] font-semibold shadow", p.status === "closed" ? "bg-done text-white" : p.status === "ready" ? "bg-attention text-white" : "bg-blocked text-white")}
                  style={{ left: p.x! * size.w, top: p.y! * size.h }}
                  aria-label={`Punch #${p.number}: ${p.title} (${p.status})`}
                >
                  {p.number}
                </button>
              ))}
          </div>
        )}
      </div>
      {draft && <PunchDialog projectId={projectId} draft={draft} team={!!q.data?.canPin} onClose={() => setDraft(null)} />}
    </div>
  );
}
