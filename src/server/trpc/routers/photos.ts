import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { MAX_COMPRESSED_PHOTO_BYTES, PHOTO_CONTENT_TYPES } from "@/core/images";
import { schema } from "../../db";
import { storage } from "../../storage";
import { recordAudit } from "../../services/audit";
import {
  assertUploadBudget,
  createPendingUpload,
  deleteStoredObjects,
  markUploadComplete,
  objectPath,
  openUpload,
  verifyUploadedObjects,
} from "../../services/uploads";
import { projectProcedure, router } from "../init";

const photoMeta = z.object({
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000),
  takenAt: z.coerce.date().nullish(),
  caption: z.string().trim().max(300).nullish(),
});

export const photosRouter = router({
  list: projectProcedure().query(async ({ ctx, input }) => {
    const rows = await ctx.db
      .select({
        id: schema.projectPhoto.id,
        width: schema.projectPhoto.width,
        height: schema.projectPhoto.height,
        caption: schema.projectPhoto.caption,
        takenAt: schema.projectPhoto.takenAt,
        createdAt: schema.projectPhoto.createdAt,
        sizeBytes: schema.projectPhoto.sizeBytes,
        uploadedById: schema.projectPhoto.uploadedById,
        uploadedByName: schema.user.name,
      })
      .from(schema.projectPhoto)
      .leftJoin(schema.user, eq(schema.user.id, schema.projectPhoto.uploadedById))
      .where(eq(schema.projectPhoto.projectId, input.projectId))
      .orderBy(desc(schema.projectPhoto.createdAt), desc(schema.projectPhoto.id))
      .limit(500);
    return rows;
  }),

  /**
   * Step 1: authorize a photo upload (full image + thumbnail, already
   * compressed on the device). Returns the exact object paths the client may
   * write; the storage token issued for them is scoped to those paths, sizes
   * and types, and expires in minutes.
   */
  beginUpload: projectProcedure("photos.upload")
    .input(
      photoMeta.extend({
        contentType: z.enum(PHOTO_CONTENT_TYPES),
        fullBytes: z.number().int().min(1).max(MAX_COMPRESSED_PHOTO_BYTES),
        thumbBytes: z.number().int().min(1).max(MAX_COMPRESSED_PHOTO_BYTES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertUploadBudget(input.fullBytes + input.thumbBytes, ctx.db);
      const ext = input.contentType === "image/webp" ? "webp" : "jpg";
      const full = objectPath(input.projectId, "photos", ext);
      const thumb = full.replace(`.${ext}`, `-thumb.${ext}`);
      const row = await createPendingUpload(ctx.db, {
        userId: ctx.viewer.id,
        projectId: input.projectId,
        purpose: "photo",
        objects: [
          { role: "full", pathname: full, maxBytes: input.fullBytes, contentType: input.contentType },
          { role: "thumb", pathname: thumb, maxBytes: input.thumbBytes, contentType: input.contentType },
        ],
        meta: { width: input.width, height: input.height, takenAt: input.takenAt?.toISOString() ?? null, caption: input.caption ?? null },
      });
      return {
        uploadId: row.id,
        mode: storage().name === "vercel-blob" ? ("blob" as const) : ("local" as const),
        objects: row.objects.map((o) => ({ role: o.role, pathname: o.pathname })),
      };
    }),

  /** Step 2: the client says it's done; the server checks the stored objects before recording anything. */
  completeUpload: projectProcedure("photos.upload")
    .input(z.object({ uploadId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await openUpload(ctx.db, input.uploadId, ctx.viewer.id);
      if (!row || row.projectId !== input.projectId || row.purpose !== "photo") {
        throw new TRPCError({ code: "NOT_FOUND", message: "This upload has expired. Try again." });
      }
      const objs = await verifyUploadedObjects(row);
      const meta = row.meta as { width: number; height: number; takenAt: string | null; caption: string | null };
      const [photo] = await ctx.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(schema.projectPhoto)
          .values({
            projectId: input.projectId,
            objectKey: objs.full!.pathname,
            thumbKey: objs.thumb!.pathname,
            contentType: objs.full!.contentType,
            sizeBytes: objs.full!.size,
            thumbBytes: objs.thumb!.size,
            width: meta.width,
            height: meta.height,
            caption: meta.caption,
            takenAt: meta.takenAt ? new Date(meta.takenAt) : null,
            uploadedById: ctx.viewer.id,
          })
          .returning({ id: schema.projectPhoto.id });
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "create",
          entityType: "project_photo",
          entityId: inserted[0]!.id,
          projectId: input.projectId,
          summary: `${ctx.viewer.name} added a photo`,
          data: { bytes: objs.full!.size + objs.thumb!.size },
          ip: ctx.ip,
        });
        return inserted;
      });
      await markUploadComplete(ctx.db, row.id, objs.full!.size + objs.thumb!.size);
      return { id: photo!.id };
    }),

  /** Pin a photo as the hero, or pass null to go back to "newest photo". */
  setHero: projectProcedure("photos.manage")
    .input(z.object({ photoId: z.uuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (input.photoId) {
        const [p] = await ctx.db
          .select({ id: schema.projectPhoto.id })
          .from(schema.projectPhoto)
          .where(and(eq(schema.projectPhoto.id, input.photoId), eq(schema.projectPhoto.projectId, input.projectId)));
        if (!p) throw new TRPCError({ code: "NOT_FOUND" });
      }
      await ctx.db.transaction(async (tx) => {
        await tx.update(schema.project).set({ heroPhotoId: input.photoId, updatedAt: new Date() }).where(eq(schema.project.id, input.projectId));
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "update",
          entityType: "project",
          entityId: input.projectId,
          projectId: input.projectId,
          summary: input.photoId ? `${ctx.viewer.name} pinned a hero photo` : `${ctx.viewer.name} unpinned the hero photo`,
          data: { heroPhotoId: input.photoId },
          ip: ctx.ip,
        });
      });
      return { ok: true };
    }),

  /** Admins remove any photo; anyone removes a photo they added themselves. */
  remove: projectProcedure()
    .input(z.object({ photoId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [p] = await ctx.db
        .select()
        .from(schema.projectPhoto)
        .where(and(eq(schema.projectPhoto.id, input.photoId), eq(schema.projectPhoto.projectId, input.projectId)));
      if (!p) throw new TRPCError({ code: "NOT_FOUND" });
      const own = p.uploadedById === ctx.viewer.id && ctx.project.can("photos.upload");
      if (!own && !ctx.project.can("photos.manage")) throw new TRPCError({ code: "FORBIDDEN" });
      await ctx.db.transaction(async (tx) => {
        await tx
          .update(schema.project)
          .set({ heroPhotoId: null })
          .where(and(eq(schema.project.id, input.projectId), eq(schema.project.heroPhotoId, input.photoId)));
        await tx.delete(schema.projectPhoto).where(eq(schema.projectPhoto.id, input.photoId));
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "delete",
          entityType: "project_photo",
          entityId: input.photoId,
          projectId: input.projectId,
          summary: `${ctx.viewer.name} removed a photo`,
          ip: ctx.ip,
        });
      });
      await deleteStoredObjects([p.objectKey, p.thumbKey], p.sizeBytes + p.thumbBytes);
      return { ok: true };
    }),
});
