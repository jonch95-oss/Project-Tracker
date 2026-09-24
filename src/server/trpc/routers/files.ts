import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { cleanDisplayName, DOWNLOAD_URL_TTL_MS, fileExtension, MAX_FILE_BYTES, MAX_THUMB_BYTES, normalizeContentType, previewKind, storedContentType } from "@/core/files";
import { safeFileName } from "@/core/images";
import { schema, type DbOrTx } from "../../db";
import { storage } from "../../storage";
import { recordAudit } from "../../services/audit";
import { attachedVisibleFileIds, defaultFolderForPhase, folderCounts, folderScope, purgeFiles, type FileRow, type FolderRow } from "../../services/files";
import { scanner } from "../../services/scan";
import { sharedTaskIds } from "../../services/tasks";
import { assertUploadBudget, claimUpload, createPendingUpload, filePath, meterStored, openUpload, verifyUploadedObjects } from "../../services/uploads";
import { projectProcedure, router, type AuthedContext, type ProjectAccess } from "../init";

type Ctx = AuthedContext & { project: ProjectAccess };

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "File not found" });

/** Tasks on the project this person can see (all of them for the internal team). */
async function visibleTaskIds(ctx: Ctx, conn: DbOrTx): Promise<string[] | "all"> {
  if (ctx.project.can("task.viewAll")) return "all";
  const shared = await sharedTaskIds(conn, ctx.project.projectId, ctx.viewer.id);
  const own = await conn.select({ id: schema.task.id }).from(schema.task).where(and(eq(schema.task.projectId, ctx.project.projectId), eq(schema.task.assigneeId, ctx.viewer.id)));
  return [...new Set([...shared, ...own.map((r) => r.id)])];
}

interface FileAccess {
  file: FileRow;
  folder: FolderRow;
  /** Seen through the folder (not just a task attachment). */
  viaFolder: boolean;
}

/** Load a file the viewer may see: through its folder, or as an attachment on a task they can see. */
async function visibleFile(ctx: Ctx, conn: DbOrTx, fileId: string, opts: { includeTrashed?: boolean } = {}): Promise<FileAccess> {
  const [row] = await conn
    .select({ file: schema.file, folder: schema.folder })
    .from(schema.file)
    .innerJoin(schema.folder, eq(schema.folder.id, schema.file.folderId))
    .where(and(eq(schema.file.id, fileId), eq(schema.file.projectId, ctx.project.projectId)));
  if (!row || (row.file.deletedAt && !opts.includeTrashed)) throw notFound();
  const scope = await folderScope(conn, ctx.project, ctx.viewer.id);
  if (scope.canSee(row.folder)) return { ...row, viaFolder: true };
  if (row.file.deletedAt) throw notFound();
  const tasks = await visibleTaskIds(ctx, conn);
  const ids = tasks === "all" ? [] : tasks;
  const attached = await attachedVisibleFileIds(conn, ctx.project.projectId, ids, ctx.project.can("financials.view"));
  if (attached.has(row.file.id)) return { ...row, viaFolder: false };
  throw notFound();
}

/** Upload into, or change files in, a folder: the internal team, or outsiders it's shared with. Gated needs financials. */
function canWriteFolder(scope: Awaited<ReturnType<typeof folderScope>>, folder: FolderRow): boolean {
  return scope.canSee(folder);
}

/** Rename, move or remove a file: whoever added it (while they can still see its folder), or checklist editors. */
function canManageFile(ctx: Ctx, a: FileAccess): boolean {
  return a.viaFolder && (ctx.project.can("checklist.edit") || a.file.createdById === ctx.viewer.id);
}

/** Is this file the document of an invoice, contract or change order? (It must stay in the gated folder.) */
async function usedByFinancials(tx: DbOrTx, fileId: string): Promise<boolean> {
  const r = await tx.execute<{ n: number }>(sql`select (
    (select count(*) from ${schema.invoice} where file_id = ${fileId}) +
    (select count(*) from ${schema.commitment} where file_id = ${fileId}) +
    (select count(*) from ${schema.changeOrder} where file_id = ${fileId}))::int as n`);
  return (r.rows[0]?.n ?? 0) > 0;
}

/** Audit entity type: anything in the gated folder is hidden from people without financial visibility. */
const entityFor = (folder: Pick<FolderRow, "gated">) => (folder.gated ? "financial_file" : "file");

async function audit(tx: DbOrTx, ctx: Ctx, folder: Pick<FolderRow, "gated">, summary: string, entityId: string, action: "create" | "update" | "delete" = "update", data?: unknown) {
  await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action, entityType: entityFor(folder), entityId, projectId: ctx.project.projectId, summary, data, ip: ctx.ip });
}

async function loadFolder(conn: DbOrTx, projectId: string, folderId: string): Promise<FolderRow> {
  const [f] = await conn.select().from(schema.folder).where(and(eq(schema.folder.id, folderId), eq(schema.folder.projectId, projectId)));
  if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "Folder not found" });
  return f;
}

const fileSummary = {
  id: schema.file.id,
  name: schema.file.name,
  folderId: schema.file.folderId,
  currentVersion: schema.file.currentVersion,
  createdById: schema.file.createdById,
  updatedAt: schema.file.updatedAt,
  deletedAt: schema.file.deletedAt,
  version: schema.file.version,
  versionId: schema.fileVersion.id,
  contentType: schema.fileVersion.contentType,
  sizeBytes: schema.fileVersion.sizeBytes,
  hasThumb: sql<boolean>`${schema.fileVersion.thumbKey} is not null`,
  scanStatus: schema.fileVersion.scanStatus,
  uploadedByName: schema.user.name,
  uploadedAt: schema.fileVersion.createdAt,
};

function currentVersionJoin() {
  return and(eq(schema.fileVersion.fileId, schema.file.id), eq(schema.fileVersion.number, schema.file.currentVersion));
}

const nameInput = z.string().trim().min(1).max(200);

export const filesRouter = router({
  /** The folders this person can see, with counts; editors also get who each folder is shared with. */
  folders: projectProcedure().query(async ({ ctx }) => {
    const c = ctx as Ctx;
    const scope = await folderScope(ctx.db, ctx.project, ctx.viewer.id);
    const counts = await folderCounts(ctx.db, [...scope.ids]);
    const canShare = ctx.project.can("project.manageMembers");
    const shares = canShare && scope.ids.size ? await ctx.db.select().from(schema.folderShare).where(inArray(schema.folderShare.folderId, [...scope.ids])) : [];
    const photoCount = scope.folders.some((f) => f.isPhotos)
      ? ((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(schema.projectPhoto).where(eq(schema.projectPhoto.projectId, ctx.project.projectId)))[0]?.n ?? 0)
      : 0;
    return {
      folders: scope.folders.map((f) => ({
        id: f.id,
        name: f.name,
        gated: f.gated,
        isPhotos: f.isPhotos,
        files: counts.get(f.id)?.files ?? 0,
        bytes: counts.get(f.id)?.bytes ?? 0,
        photos: f.isPhotos ? photoCount : 0,
        sharedWith: canShare ? shares.filter((s) => s.folderId === f.id).map((s) => s.userId) : [],
      })),
      access: {
        canUpload: scope.folders.length > 0,
        canEditFolders: ctx.project.can("checklist.edit"),
        canShare,
        canManageAll: ctx.project.can("checklist.edit"),
        canPurge: ctx.project.can("project.edit"),
        viewerId: c.viewer.id,
      },
    };
  }),

  /** Live files in one folder, newest first. */
  list: projectProcedure()
    .input(z.object({ folderId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const scope = await folderScope(ctx.db, ctx.project, ctx.viewer.id);
      if (!scope.ids.has(input.folderId)) throw new TRPCError({ code: "NOT_FOUND", message: "Folder not found" });
      const rows = await ctx.db
        .select(fileSummary)
        .from(schema.file)
        .innerJoin(schema.fileVersion, currentVersionJoin())
        .leftJoin(schema.user, eq(schema.user.id, schema.fileVersion.uploadedById))
        .where(and(eq(schema.file.folderId, input.folderId), isNull(schema.file.deletedAt)))
        .orderBy(desc(schema.file.updatedAt), desc(schema.file.id))
        .limit(1000);
      return rows.map((r) => ({ ...r, preview: previewKind(r.contentType) }));
    }),

  /** Just "may this person read this file?" — for the download route (no version or task lists). */
  canRead: projectProcedure()
    .input(z.object({ fileId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      await visibleFile(ctx as Ctx, ctx.db, input.fileId);
      return { ok: true };
    }),

  /** One file: its versions, and the tasks it's attached to (those the viewer can see). */
  get: projectProcedure()
    .input(z.object({ fileId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      const a = await visibleFile(c, ctx.db, input.fileId);
      const versions = await ctx.db
        .select({ id: schema.fileVersion.id, number: schema.fileVersion.number, originalName: schema.fileVersion.originalName, contentType: schema.fileVersion.contentType, sizeBytes: schema.fileVersion.sizeBytes, hasThumb: sql<boolean>`${schema.fileVersion.thumbKey} is not null`, scanStatus: schema.fileVersion.scanStatus, note: schema.fileVersion.note, uploadedByName: schema.user.name, createdAt: schema.fileVersion.createdAt })
        .from(schema.fileVersion)
        .leftJoin(schema.user, eq(schema.user.id, schema.fileVersion.uploadedById))
        .where(eq(schema.fileVersion.fileId, a.file.id))
        .orderBy(desc(schema.fileVersion.number));
      const tasks = await visibleTaskIds(c, ctx.db);
      const attached = await ctx.db
        .select({ id: schema.task.id, title: schema.task.title })
        .from(schema.taskAttachment)
        .innerJoin(schema.task, eq(schema.task.id, schema.taskAttachment.taskId))
        .where(and(eq(schema.taskAttachment.fileId, a.file.id), tasks === "all" ? undefined : tasks.length ? inArray(schema.task.id, tasks) : sql`false`));
      return {
        id: a.file.id,
        name: a.file.name,
        version: a.file.version,
        folder: a.viaFolder ? { id: a.folder.id, name: a.folder.name, gated: a.folder.gated } : null,
        currentVersion: a.file.currentVersion,
        versions: versions.map((v) => ({ ...v, preview: previewKind(v.contentType) })),
        tasks: attached,
        access: { canManage: canManageFile(c, a), canAddVersion: a.viaFolder },
      };
    }),

  /**
   * Step 1 of an upload (a new file, or a new version of one): authorize the
   * exact objects the device may write — the file, and for images a small
   * thumbnail made on the device.
   */
  beginUpload: projectProcedure()
    .input(
      z.object({
        folderId: z.uuid().optional(),
        fileId: z.uuid().optional(),
        name: nameInput,
        contentType: z.string().max(255),
        sizeBytes: z.number().int().min(1).max(MAX_FILE_BYTES),
        thumb: z.object({ bytes: z.number().int().min(1).max(MAX_THUMB_BYTES), contentType: z.enum(["image/webp", "image/jpeg"]) }).optional(),
        taskId: z.uuid().optional(),
        note: z.string().trim().max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      if (input.folderId && input.fileId) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a folder, or a file to add a version to." });
      if (!input.folderId && !input.fileId && !input.taskId) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a folder." });
      const scope = await folderScope(ctx.db, ctx.project, ctx.viewer.id);
      const task = input.taskId ? await assertTaskAttachable(c, ctx.db, input.taskId) : null;
      let folder: FolderRow;
      // Uploading straight onto a task you work (e.g. an outside collaborator's required attachment)
      // doesn't need access to the folder it's filed in: they see it on the task only.
      let viaTask = false;
      if (input.fileId) {
        const a = await visibleFile(c, ctx.db, input.fileId);
        if (!a.viaFolder) throw new TRPCError({ code: "FORBIDDEN", message: "You can open this file from the task, but not add versions to it." });
        folder = a.folder;
      } else if (input.folderId) {
        folder = await loadFolder(ctx.db, input.projectId, input.folderId);
        if (!scope.canSee(folder)) throw new TRPCError({ code: "NOT_FOUND", message: "Folder not found" });
      } else {
        const all = await ctx.db.select().from(schema.folder).where(eq(schema.folder.projectId, input.projectId));
        const id = defaultFolderForPhase(all, task!.phaseKey);
        if (!id) throw new TRPCError({ code: "BAD_REQUEST", message: "This project has no folder for task files." });
        folder = all.find((f) => f.id === id)!;
        viaTask = !scope.canSee(folder);
      }
      if (!viaTask && !canWriteFolder(scope, folder)) throw new TRPCError({ code: "FORBIDDEN" });
      // Only images and PDFs keep their type (they preview); everything else is stored as a plain
      // download, so nothing uploaded can ever render as a page (HTML, SVG) from storage.
      const contentType = storedContentType(normalizeContentType(input.contentType));
      if (input.thumb && previewKind(contentType) !== "image") throw new TRPCError({ code: "BAD_REQUEST", message: "Only images carry a thumbnail." });
      await assertUploadBudget(input.sizeBytes + (input.thumb?.bytes ?? 0), ctx.db);
      const name = cleanDisplayName(input.name);
      const ext = fileExtension(name);
      const base = safeFileName(ext ? name.slice(0, -(ext.length + 1)) : name, "file");
      const { dir, object } = filePath(input.projectId, ext ? `${base}.${ext}` : base);
      const row = await createPendingUpload(ctx.db, {
        userId: ctx.viewer.id,
        projectId: input.projectId,
        purpose: "file",
        objects: [
          { role: "file", pathname: object, maxBytes: input.sizeBytes, contentType },
          // A sibling of the file's folder, so no file name can collide with it.
          ...(input.thumb ? [{ role: "thumb", pathname: `${dir}.thumb.${input.thumb.contentType === "image/webp" ? "webp" : "jpg"}`, maxBytes: input.thumb.bytes, contentType: input.thumb.contentType }] : []),
        ],
        meta: { folderId: folder.id, fileId: input.fileId ?? null, name, taskId: input.taskId ?? null, note: input.note ?? null, viaTask },
      });
      return {
        uploadId: row.id,
        mode: storage().name === "vercel-blob" ? ("blob" as const) : ("local" as const),
        objects: row.objects.map((o) => ({ role: o.role, pathname: o.pathname, contentType: o.contentType })),
      };
    }),

  /** Step 2: check the stored bytes, run the scan hook, then record the file (or new version) and any task attachment. */
  completeUpload: projectProcedure()
    .input(z.object({ uploadId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      const row = await openUpload(ctx.db, input.uploadId, ctx.viewer.id);
      if (!row || row.projectId !== input.projectId || row.purpose !== "file") throw new TRPCError({ code: "NOT_FOUND", message: "This upload has expired. Try again." });
      const meta = row.meta as { folderId: string; fileId: string | null; name: string; taskId: string | null; note: string | null; viaTask?: boolean };
      const objs = await verifyUploadedObjects(row);
      const main = objs.file!;
      const thumb = objs.thumb ?? null;
      const bytes = main.size + (thumb?.size ?? 0);
      // Claim first: a double-submit can't scan twice or race the recording.
      if (!(await ctx.db.transaction((tx) => claimUpload(tx, row.id, ctx.viewer.id)))) throw new TRPCError({ code: "NOT_FOUND", message: "This upload has already been saved or has expired." });
      const discard = () => storage().delete(row.objects.map((o) => o.pathname)).catch(() => undefined);
      const scan = scanner();
      const result = scan.enabled ? await scan.scan({ downloadUrl: await storage().signedGetUrl(main.pathname, DOWNLOAD_URL_TTL_MS).catch(() => null), name: meta.name, contentType: main.contentType, size: main.size }) : "not_scanned";
      if (result === "infected") {
        await discard();
        throw new TRPCError({ code: "BAD_REQUEST", message: "The virus scan flagged this file, so it wasn't saved." });
      }
      let out: { fileId: string; number: number };
      try {
        out = await ctx.db.transaction(async (tx) => {
          // Re-check access: shares, folders or the task may have changed during the upload.
          const scope = await folderScope(tx, ctx.project, ctx.viewer.id);
          const folder = await loadFolder(tx, input.projectId, meta.folderId);
          if (meta.viaTask) {
            if (!meta.taskId) throw new TRPCError({ code: "FORBIDDEN" });
            await assertTaskAttachable(c, tx, meta.taskId);
          } else if (!canWriteFolder(scope, folder)) throw new TRPCError({ code: "FORBIDDEN" });
          let fileId = meta.fileId;
          let number = 1;
          if (fileId) {
            const [f] = await tx.select().from(schema.file).where(and(eq(schema.file.id, fileId), eq(schema.file.projectId, input.projectId))).for("update");
            if (!f || f.deletedAt || f.folderId !== folder.id) throw new TRPCError({ code: "CONFLICT", message: "That file was moved or removed while you were uploading." });
            number = f.currentVersion + 1;
            await tx.update(schema.file).set({ currentVersion: number, updatedAt: new Date(), version: sql`${schema.file.version} + 1` }).where(eq(schema.file.id, f.id));
          } else {
            const [f] = await tx.insert(schema.file).values({ projectId: input.projectId, folderId: folder.id, name: meta.name, createdById: ctx.viewer.id }).returning();
            fileId = f!.id;
          }
          await tx.insert(schema.fileVersion).values({
            fileId,
            number,
            objectKey: main.pathname,
            thumbKey: thumb?.pathname ?? null,
            originalName: meta.name,
            contentType: main.contentType,
            sizeBytes: main.size,
            thumbBytes: thumb?.size ?? 0,
            scanStatus: result,
            note: meta.note,
            uploadedById: ctx.viewer.id,
          });
          if (meta.taskId) {
            await assertTaskAttachable(c, tx, meta.taskId);
            await tx.insert(schema.taskAttachment).values({ taskId: meta.taskId, fileId, addedById: ctx.viewer.id }).onConflictDoNothing();
          }
          await audit(tx, c, folder, number === 1 ? `${ctx.viewer.name} added ${meta.name} to ${folder.name}` : `${ctx.viewer.name} uploaded version ${number} of ${meta.name}`, fileId, "create", { bytes: main.size, taskId: meta.taskId });
          return { fileId, number };
        });
      } catch (e) {
        // Nothing points at the bytes: remove them (the claimed row is never cleaned up otherwise).
        await discard();
        throw e;
      }
      await meterStored(bytes);
      return { ...out, scanStatus: result };
    }),

  rename: projectProcedure()
    .input(z.object({ fileId: z.uuid(), version: z.number().int().min(1), name: nameInput }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const a = await visibleFile(c, tx, input.fileId);
        if (!canManageFile(c, a)) throw new TRPCError({ code: "FORBIDDEN" });
        const name = cleanDisplayName(input.name);
        const r = await tx.update(schema.file).set({ name, updatedAt: new Date(), version: sql`${schema.file.version} + 1` }).where(and(eq(schema.file.id, a.file.id), eq(schema.file.version, input.version))).returning({ version: schema.file.version });
        if (!r.length) throw new TRPCError({ code: "CONFLICT", message: "Someone else changed this file a moment ago. It has been refreshed; try again." });
        await audit(tx, c, a.folder, `${ctx.viewer.name} renamed ${a.file.name} to ${name}`, a.file.id);
        return { version: r[0]!.version };
      });
    }),

  /** Move to another folder. Moving into or out of the gated folder needs financial visibility (checked by folder access). */
  move: projectProcedure()
    .input(z.object({ fileId: z.uuid(), version: z.number().int().min(1), folderId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const a = await visibleFile(c, tx, input.fileId);
        if (!canManageFile(c, a)) throw new TRPCError({ code: "FORBIDDEN" });
        const scope = await folderScope(tx, ctx.project, ctx.viewer.id);
        const to = await loadFolder(tx, input.projectId, input.folderId);
        if (!scope.canSee(to)) throw new TRPCError({ code: "NOT_FOUND", message: "Folder not found" });
        if (a.folder.gated && !to.gated && (await usedByFinancials(tx, a.file.id))) throw new TRPCError({ code: "BAD_REQUEST", message: "This is the document for an invoice, contract or change order, so it stays in the Financial folder." });
        const r = await tx.update(schema.file).set({ folderId: to.id, updatedAt: new Date(), version: sql`${schema.file.version} + 1` }).where(and(eq(schema.file.id, a.file.id), eq(schema.file.version, input.version))).returning({ version: schema.file.version });
        if (!r.length) throw new TRPCError({ code: "CONFLICT", message: "Someone else changed this file a moment ago. It has been refreshed; try again." });
        // A move across the gate is logged as financial so its name never shows to people without access.
        await audit(tx, c, { gated: a.folder.gated || to.gated }, `${ctx.viewer.name} moved ${a.file.name} from ${a.folder.name} to ${to.name}`, a.file.id);
        return { version: r[0]!.version };
      });
    }),

  /** To the trash (restorable for 30 days). */
  remove: projectProcedure()
    .input(z.object({ fileId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const a = await visibleFile(c, tx, input.fileId);
        if (!canManageFile(c, a)) throw new TRPCError({ code: "FORBIDDEN" });
        if (await usedByFinancials(tx, a.file.id)) throw new TRPCError({ code: "BAD_REQUEST", message: "This is the document for an invoice, contract or change order. Remove it there first." });
        await tx.update(schema.file).set({ deletedAt: new Date(), deletedById: ctx.viewer.id, version: sql`${schema.file.version} + 1` }).where(and(eq(schema.file.id, a.file.id), isNull(schema.file.deletedAt)));
        await audit(tx, c, a.folder, `${ctx.viewer.name} moved ${a.file.name} to the trash`, a.file.id, "delete");
        return { ok: true };
      });
    }),

  /** Files in the trash on this project that the viewer could manage. */
  trash: projectProcedure("checklist.edit").query(async ({ ctx }) => {
    const scope = await folderScope(ctx.db, ctx.project, ctx.viewer.id);
    if (scope.ids.size === 0) return [];
    const rows = await ctx.db
      .select({ ...fileSummary, folderName: schema.folder.name })
      .from(schema.file)
      .innerJoin(schema.folder, eq(schema.folder.id, schema.file.folderId))
      .innerJoin(schema.fileVersion, currentVersionJoin())
      .leftJoin(schema.user, eq(schema.user.id, schema.fileVersion.uploadedById))
      .where(and(eq(schema.file.projectId, ctx.project.projectId), isNotNull(schema.file.deletedAt), inArray(schema.file.folderId, [...scope.ids])))
      .orderBy(desc(schema.file.deletedAt));
    return rows;
  }),

  restore: projectProcedure("checklist.edit")
    .input(z.object({ fileId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const a = await visibleFile(c, tx, input.fileId, { includeTrashed: true });
        if (!a.file.deletedAt) return { ok: true };
        await tx.update(schema.file).set({ deletedAt: null, deletedById: null, updatedAt: new Date(), version: sql`${schema.file.version} + 1` }).where(eq(schema.file.id, a.file.id));
        await audit(tx, c, a.folder, `${ctx.viewer.name} restored ${a.file.name}`, a.file.id);
        return { ok: true };
      });
    }),

  /** Delete from the trash now (bytes gone for good). Owner and admins only. */
  purge: projectProcedure("project.edit")
    .input(z.object({ fileId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      const a = await visibleFile(c, ctx.db, input.fileId, { includeTrashed: true });
      if (!a.file.deletedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Move it to the trash first." });
      await ctx.db.transaction(async (tx) => audit(tx, c, a.folder, `${ctx.viewer.name} permanently deleted ${a.file.name}`, a.file.id, "delete"));
      await purgeFiles(ctx.db, [a.file.id]);
      return { ok: true };
    }),

  /** Attach an existing file to a task (it stays in its folder). */
  attach: projectProcedure()
    .input(z.object({ taskId: z.uuid(), fileId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const a = await visibleFile(c, tx, input.fileId);
        if (!a.viaFolder) throw new TRPCError({ code: "FORBIDDEN" });
        const t = await assertTaskAttachable(c, tx, input.taskId);
        await tx.insert(schema.taskAttachment).values({ taskId: t.id, fileId: a.file.id, addedById: ctx.viewer.id }).onConflictDoNothing();
        await audit(tx, c, a.folder, `${ctx.viewer.name} attached ${a.file.name} to "${t.title}"`, a.file.id, "update", { taskId: t.id });
        return { ok: true };
      });
    }),

  detach: projectProcedure()
    .input(z.object({ taskId: z.uuid(), fileId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const t = await assertTaskAttachable(c, tx, input.taskId);
        const [row] = await tx
          .select({ gated: schema.folder.gated, name: schema.file.name })
          .from(schema.taskAttachment)
          .innerJoin(schema.file, eq(schema.file.id, schema.taskAttachment.fileId))
          .innerJoin(schema.folder, eq(schema.folder.id, schema.file.folderId))
          .where(and(eq(schema.taskAttachment.taskId, t.id), eq(schema.taskAttachment.fileId, input.fileId)));
        if (!row) return { ok: true };
        if (row.gated && !ctx.project.can("financials.view")) throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
        await tx.delete(schema.taskAttachment).where(and(eq(schema.taskAttachment.taskId, t.id), eq(schema.taskAttachment.fileId, input.fileId)));
        await audit(tx, c, row, `${ctx.viewer.name} detached ${row.name} from "${t.title}"`, input.fileId, "update", { taskId: t.id });
        return { ok: true };
      });
    }),

  /** A task's attachments the viewer may see. */
  forTask: projectProcedure()
    .input(z.object({ taskId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      const tasks = await visibleTaskIds(c, ctx.db);
      if (tasks !== "all" && !tasks.includes(input.taskId)) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      const scope = await folderScope(ctx.db, ctx.project, ctx.viewer.id);
      const fin = ctx.project.can("financials.view");
      const rows = await ctx.db
        .select({ ...fileSummary, gated: schema.folder.gated, folderName: schema.folder.name })
        .from(schema.taskAttachment)
        .innerJoin(schema.file, eq(schema.file.id, schema.taskAttachment.fileId))
        .innerJoin(schema.folder, eq(schema.folder.id, schema.file.folderId))
        .innerJoin(schema.fileVersion, currentVersionJoin())
        .leftJoin(schema.user, eq(schema.user.id, schema.fileVersion.uploadedById))
        .where(and(eq(schema.taskAttachment.taskId, input.taskId), eq(schema.file.projectId, input.projectId), isNull(schema.file.deletedAt)))
        .orderBy(asc(schema.taskAttachment.createdAt));
      const files = rows.filter((r) => !r.gated || fin).map((r) => ({ ...r, preview: previewKind(r.contentType), folderName: scope.ids.has(r.folderId) ? r.folderName : null }));
      // Attachments this person can't see still count toward a required attachment.
      return { files, hidden: rows.length - files.length };
    }),

  /* ---------------- folders ---------------- */

  createFolder: projectProcedure("checklist.edit")
    .input(z.object({ name: z.string().trim().min(1).max(80) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [max] = await tx.select({ m: sql<number>`coalesce(max(${schema.folder.sortOrder}), -1)::int` }).from(schema.folder).where(eq(schema.folder.projectId, input.projectId));
        const r = await tx.insert(schema.folder).values({ projectId: input.projectId, name: input.name, sortOrder: (max?.m ?? -1) + 1 }).onConflictDoNothing().returning({ id: schema.folder.id });
        if (!r.length) throw new TRPCError({ code: "CONFLICT", message: "There's already a folder with that name." });
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "create", entityType: "folder", entityId: r[0]!.id, projectId: input.projectId, summary: `${ctx.viewer.name} added the folder ${input.name}`, ip: ctx.ip });
        return { id: r[0]!.id };
      });
    }),

  renameFolder: projectProcedure("checklist.edit")
    .input(z.object({ folderId: z.uuid(), name: z.string().trim().min(1).max(80) }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const f = await loadFolder(tx, input.projectId, input.folderId);
        const scope = await folderScope(tx, ctx.project, ctx.viewer.id);
        if (!scope.canSee(f)) throw new TRPCError({ code: "NOT_FOUND", message: "Folder not found" });
        const clash = await tx.select({ id: schema.folder.id }).from(schema.folder).where(and(eq(schema.folder.projectId, input.projectId), ne(schema.folder.id, f.id), sql`lower(${schema.folder.name}) = lower(${input.name})`));
        if (clash.length) throw new TRPCError({ code: "CONFLICT", message: "There's already a folder with that name." });
        await tx.update(schema.folder).set({ name: input.name }).where(eq(schema.folder.id, f.id));
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "update", entityType: f.gated ? "financial_file" : "folder", entityId: f.id, projectId: input.projectId, summary: `${c.viewer.name} renamed the folder ${f.name} to ${input.name}`, ip: ctx.ip });
        return { ok: true };
      });
    }),

  /** Only empty folders (no live or trashed files) can go; the gated and Photos folders stay. */
  deleteFolder: projectProcedure("checklist.edit")
    .input(z.object({ folderId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const f = await loadFolder(tx, input.projectId, input.folderId);
        const scope = await folderScope(tx, ctx.project, ctx.viewer.id);
        if (!scope.canSee(f)) throw new TRPCError({ code: "NOT_FOUND", message: "Folder not found" });
        if (f.gated || f.isPhotos) throw new TRPCError({ code: "BAD_REQUEST", message: `The ${f.name} folder can't be removed.` });
        const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.file).where(eq(schema.file.folderId, f.id));
        if ((n?.n ?? 0) > 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Move or delete its files first (including any in the trash)." });
        await tx.delete(schema.folder).where(eq(schema.folder.id, f.id));
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "delete", entityType: "folder", entityId: f.id, projectId: input.projectId, summary: `${ctx.viewer.name} removed the folder ${f.name}`, ip: ctx.ip });
        return { ok: true };
      });
    }),

  /** Share a folder with an outside collaborator on the project (or stop sharing). The gated folder needs their financial access. */
  shareFolder: projectProcedure("project.manageMembers")
    .input(z.object({ folderId: z.uuid(), userId: z.string().min(1).max(64), on: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const f = await loadFolder(tx, input.projectId, input.folderId);
        const scope = await folderScope(tx, ctx.project, ctx.viewer.id);
        if (!scope.canSee(f)) throw new TRPCError({ code: "NOT_FOUND", message: "Folder not found" });
        const [m] = await tx
          .select({ role: schema.user.role, name: schema.user.name, fin: schema.projectMember.canViewFinancials })
          .from(schema.projectMember)
          .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
          .where(and(eq(schema.projectMember.projectId, input.projectId), eq(schema.projectMember.userId, input.userId)));
        if (!m) throw new TRPCError({ code: "BAD_REQUEST", message: "That person isn't on this project." });
        if (m.role !== "external") throw new TRPCError({ code: "BAD_REQUEST", message: "The internal team already sees every folder." });
        if (input.on && f.gated && !m.fin) throw new TRPCError({ code: "BAD_REQUEST", message: "Give them financial access on the Team tab first." });
        if (input.on) await tx.insert(schema.folderShare).values({ folderId: f.id, userId: input.userId }).onConflictDoNothing();
        else await tx.delete(schema.folderShare).where(and(eq(schema.folderShare.folderId, f.id), eq(schema.folderShare.userId, input.userId)));
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "update", entityType: f.gated ? "financial_file" : "folder", entityId: f.id, projectId: input.projectId, summary: input.on ? `${ctx.viewer.name} shared ${f.name} with ${m.name}` : `${ctx.viewer.name} stopped sharing ${f.name} with ${m.name}`, ip: ctx.ip });
        return { ok: true };
      });
    }),
});

/** A task the viewer can see and work, on this project. */
async function assertTaskAttachable(ctx: Ctx, conn: DbOrTx, taskId: string) {
  const [t] = await conn.select().from(schema.task).where(and(eq(schema.task.id, taskId), eq(schema.task.projectId, ctx.project.projectId)));
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
  const tasks = await visibleTaskIds(ctx, conn);
  if (tasks !== "all" && !tasks.includes(t.id)) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
  if (!ctx.project.can("task.viewAll") && t.assigneeId !== ctx.viewer.id) throw new TRPCError({ code: "FORBIDDEN", message: "Only the person the task is assigned to can attach files to it." });
  return t;
}

