"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ErrorState } from "@/components/ui/architecture";
import {
  IconCamera,
  IconClose,
  IconPin,
  IconPlus,
} from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Button, Skeleton, StatusPill } from "@/components/ui/primitives";
import { formatDateTimeET } from "@/core/time";
import { cn } from "@/lib/cn";
import { LocationToggle } from "@/components/location-toggle";
import { cameraOptions } from "@/lib/camera";
import {
  compressPhoto,
  PhotoError,
  photoUrl,
  putObject,
  type CaptureOptions,
} from "@/lib/photo-upload";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";


interface Props {
  projectId: string;
  heroPhotoId: string | null;
  pinnedHeroId: string | null;
  canUpload: boolean;
  canManage: boolean;
  viewerId: string;
}

/** Site photos: upload (compressed on the device), browse, pin the hero, remove. */
export function PhotoGallery({
  projectId,
  heroPhotoId,
  pinnedHeroId,
  canUpload,
  canManage,
  viewerId,
}: Props) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const toast = useToast();
  const photos = useQuery(trpc.photos.list.queryOptions({ projectId }));
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({
        queryKey: trpc.photos.list.queryKey({ projectId }),
      }),
      qc.invalidateQueries({
        queryKey: trpc.projects.get.queryKey({ projectId }),
      }),
      qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() }),
    ]);
  };

  async function uploadFiles(files: File[], opts: CaptureOptions = {}) {
    if (files.length === 0) return;
    setProgress({ done: 0, total: files.length });
    let ok = 0;
    for (const [i, file] of files.entries()) {
      try {
        const c = await compressPhoto(file, opts);
        const begin = await client.photos.beginUpload.mutate({
          projectId,
          contentType: c.contentType,
          fullBytes: c.full.size,
          thumbBytes: c.thumb.size,
          width: c.width,
          height: c.height,
          takenAt: c.takenAt,
          location: opts.location ?? null,
        });
        for (const o of begin.objects)
          await putObject(
            begin.mode,
            begin.uploadId,
            o.pathname,
            o.role === "full" ? c.full : c.thumb,
            c.contentType,
          );
        await client.photos.completeUpload.mutate({
          projectId,
          uploadId: begin.uploadId,
        });
        ok++;
      } catch (e) {
        toast(
          "error",
          e instanceof PhotoError
            ? `${file.name}: ${e.message}`
            : `${file.name}: ${errorMessage(e)}`,
        );
      }
      setProgress({ done: i + 1, total: files.length });
    }
    setProgress(null);
    if (ok) toast("success", ok === 1 ? "Photo added" : `${ok} photos added`);
    await refresh();
  }

  const setHero = useMutation(
    trpc.photos.setHero.mutationOptions({
      onSuccess: async (_d, v) => {
        toast(
          "success",
          v.photoId
            ? "Pinned as the hero photo"
            : "The newest photo is the hero again",
        );
        await refresh();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const remove = useMutation(
    trpc.photos.remove.mutationOptions({
      onSuccess: async () => {
        setRemoving(null);
        setOpen(null);
        toast("success", "Photo removed");
        await refresh();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );

  const list = photos.data ?? [];
  const current = list.find((p) => p.id === open) ?? null;

  return (
    <section aria-labelledby="photos-h">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id="photos-h" className="serif text-heading">
          Photos
        </h2>
        {canUpload && (
          <>
            <input
              ref={input}
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              aria-label="Choose photos to upload"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                void uploadFiles(files);
              }}
            />
            <input
              ref={camera}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              aria-label="Take a photo"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                void cameraOptions(files).then((o) => uploadFiles(files, o));
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <LocationToggle />
              <Button
                variant="secondary"
                onClick={() => camera.current?.click()}
                disabled={!!progress}
              >
                <IconCamera size={18} /> Take photo
              </Button>
              <Button
                variant="secondary"
                onClick={() => input.current?.click()}
                loading={!!progress}
              >
                {progress ? (
                  `Uploading ${progress.done + 1} of ${progress.total}…`
                ) : (
                  <>
                    <IconPlus size={18} /> Add photos
                  </>
                )}
              </Button>
            </div>
          </>
        )}
      </div>

      {photos.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="aspect-[4/3] rounded-panel" />
          ))}
        </div>
      ) : photos.isError ? (
        <ErrorState onRetry={() => photos.refetch()} />
      ) : list.length === 0 ? (
        <div className="rounded-card border border-dashed border-border-strong bg-surface/60 px-6 py-10 text-center">
          <p className="serif text-subheading">No photos yet</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            {canUpload
              ? "Add site photos from your phone or computer. They're compressed before upload; the newest becomes the hero unless you pin one."
              : "Photos added by the team will appear here."}
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {list.map((p) => (
            <li key={p.id} className="relative">
              <button
                type="button"
                onClick={() => setOpen(p.id)}
                className="group block w-full overflow-hidden rounded-panel border border-border bg-stone"
                aria-label={`Open photo ${p.takenAt ? `taken ${formatDateTimeET(p.takenAt)}` : `added ${formatDateTimeET(p.createdAt)}`}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- private, access-checked route */}
                <img
                  src={photoUrl(p.id)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="aspect-[4/3] w-full object-cover transition-transform duration-200 ease-quiet group-hover:scale-[1.02]"
                />
              </button>
              {p.id === heroPhotoId && (
                <StatusPill
                  tone="accent"
                  className="pointer-events-none absolute left-2 top-2"
                >
                  {pinnedHeroId ? "Pinned hero" : "Hero"}
                </StatusPill>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={!!current}
        onClose={() => setOpen(null)}
        size="lg"
        title={current?.caption || "Site photo"}
        description={
          current
            ? `${current.uploadedByName ?? "Someone"} · ${current.takenAt ? `taken ${formatDateTimeET(current.takenAt)}` : `added ${formatDateTimeET(current.createdAt)}`}`
            : undefined
        }
        footer={
          current && (
            <>
              {(canManage ||
                (canUpload && current.uploadedById === viewerId)) && (
                <Button
                  variant="danger"
                  onClick={() => setRemoving(current.id)}
                >
                  <IconClose size={16} /> Remove
                </Button>
              )}
              {canManage &&
                (pinnedHeroId === current.id ? (
                  <Button
                    variant="secondary"
                    loading={setHero.isPending}
                    onClick={() => setHero.mutate({ projectId, photoId: null })}
                  >
                    Unpin hero
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    loading={setHero.isPending}
                    onClick={() =>
                      setHero.mutate({ projectId, photoId: current.id })
                    }
                  >
                    Pin as hero
                  </Button>
                ))}
              {current.latitude != null && current.longitude != null && (
                <a
                  href={`https://maps.apple.com/?ll=${current.latitude},${current.longitude}&q=${encodeURIComponent("Photo location")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-10 items-center gap-1 rounded-control px-4 text-sm font-medium hover:bg-sunken"
                >
                  <IconPin size={16} /> Map
                </a>
              )}
              <a
                href={photoUrl(current.id, "full")}
                target="_blank"
                rel="noopener"
                className="inline-flex h-10 items-center rounded-control px-4 text-sm font-medium hover:bg-sunken"
              >
                Full size
              </a>
            </>
          )
        }
      >
        {current && (
          // eslint-disable-next-line @next/next/no-img-element -- private, access-checked route
          <img
            src={photoUrl(current.id, "full")}
            alt=""
            className={cn("max-h-[65vh] w-full rounded-panel object-contain")}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={!!removing}
        title="Remove this photo?"
        body="It is deleted from storage for everyone. This can't be undone."
        confirmLabel="Remove photo"
        danger
        busy={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() =>
          removing && remove.mutate({ projectId, photoId: removing })
        }
      />
    </section>
  );
}
