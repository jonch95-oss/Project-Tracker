import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { canProject } from "@/core/permissions";
import { canSeeFolder, DEFAULT_GATED_FOLDER, PHOTOS_FOLDER, TRASH_DAYS } from "@/core/files";
import { DEFAULT_FOLDERS } from "@/core/seed-library";
import { db, schema, type Database, type DbOrTx } from "../db";
import type { ProjectAccess } from "../trpc/init";
import { deleteStoredObjects } from "./uploads";

export type FolderRow = typeof schema.folder.$inferSelect;
export type FileRow = typeof schema.file.$inferSelect;

/**
 * A new project's folders, from its template (or the defaults). Financial
 * (gated) and Photos are always there, whatever the template says, so money
 * documents always have a restricted home and site photos can be shared.
 */
export async function ensureProjectFolders(tx: DbOrTx, projectId: string, names: readonly string[] = DEFAULT_FOLDERS): Promise<void> {
  const list = [...(names.length ? names : DEFAULT_FOLDERS)];
  for (const must of [PHOTOS_FOLDER, DEFAULT_GATED_FOLDER]) if (!list.some((n) => n.toLowerCase() === must.toLowerCase())) list.push(must);
  await tx
    .insert(schema.folder)
    .values(list.map((name, i) => ({ projectId, name, gated: name === DEFAULT_GATED_FOLDER, isPhotos: name === PHOTOS_FOLDER, sortOrder: i })))
    .onConflictDoNothing();
}

export interface FolderScope {
  /** Folders this person sees, in order. */
  folders: FolderRow[];
  ids: Set<string>;
  /** Folder ids shared with them (outsiders). */
  shared: Set<string>;
  canSee: (f: Pick<FolderRow, "id" | "gated">) => boolean;
}

/** The folders on a project one person may see (brief §4, §14). */
export async function folderScope(conn: DbOrTx, access: ProjectAccess, userId: string): Promise<FolderScope> {
  const all = await conn.select().from(schema.folder).where(eq(schema.folder.projectId, access.projectId)).orderBy(asc(schema.folder.sortOrder), asc(schema.folder.createdAt));
  const seesAll = access.can("folder.viewAll");
  const financials = access.can("financials.view");
  const shared = seesAll
    ? new Set<string>()
    : new Set(
        (
          await conn
            .select({ id: schema.folderShare.folderId })
            .from(schema.folderShare)
            .innerJoin(schema.folder, eq(schema.folder.id, schema.folderShare.folderId))
            .where(and(eq(schema.folder.projectId, access.projectId), eq(schema.folderShare.userId, userId)))
        ).map((r) => r.id),
      );
  const canSee = (f: Pick<FolderRow, "id" | "gated">) => canSeeFolder(f, { seesAll, financials, shared: shared.has(f.id) });
  const folders = all.filter(canSee);
  return { folders, ids: new Set(folders.map((f) => f.id)), shared, canSee };
}

/** Is the project's Photos folder visible to this person? (site photos follow it) */
export async function canSeePhotos(conn: DbOrTx, access: ProjectAccess, userId: string): Promise<boolean> {
  if (access.can("folder.viewAll")) return true;
  const [f] = await conn
    .select({ id: schema.folder.id })
    .from(schema.folder)
    .innerJoin(schema.folderShare, and(eq(schema.folderShare.folderId, schema.folder.id), eq(schema.folderShare.userId, userId)))
    .where(and(eq(schema.folder.projectId, access.projectId), eq(schema.folder.isPhotos, true)));
  return !!f;
}

/** Of these projects, those whose Photos folder is shared with this outside collaborator. */
export async function projectsWithSharedPhotos(conn: DbOrTx, userId: string, projectIds: string[]): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();
  const rows = await conn
    .select({ projectId: schema.folder.projectId })
    .from(schema.folder)
    .innerJoin(schema.folderShare, and(eq(schema.folderShare.folderId, schema.folder.id), eq(schema.folderShare.userId, userId)))
    .where(and(inArray(schema.folder.projectId, projectIds), eq(schema.folder.isPhotos, true)));
  return new Set(rows.map((r) => r.projectId));
}

/** The folder a task's uploads go to by default: by phase, else the first ordinary folder. */
export function defaultFolderForPhase(folders: Pick<FolderRow, "id" | "name" | "gated" | "isPhotos">[], phaseKey: string): string | null {
  const byPhase: Record<string, string> = {
    design_zoning: "Design",
    dob_filing: "DOB & Permits",
    tco_co: "DOB & Permits",
    pre_construction: "Construction",
    construction: "Construction",
    ag_plan_sales: "Sales",
    marketing: "Sales",
    closed: "Closeout",
    due_diligence: "Title & Survey",
  };
  const plain = folders.filter((f) => !f.gated && !f.isPhotos);
  const want = byPhase[phaseKey] ?? "Acquisition";
  return (plain.find((f) => f.name.toLowerCase() === want.toLowerCase()) ?? plain[0] ?? null)?.id ?? null;
}

/**
 * Files attached to tasks this person can see show on those tasks even if
 * the folder isn't theirs — except anything in the gated Financial folder,
 * which always needs financial visibility.
 */
export async function attachedVisibleFileIds(conn: DbOrTx, projectId: string, visibleTaskIds: string[], financials: boolean): Promise<Set<string>> {
  if (visibleTaskIds.length === 0) return new Set();
  const rows = await conn
    .select({ id: schema.file.id, gated: schema.folder.gated })
    .from(schema.taskAttachment)
    .innerJoin(schema.file, eq(schema.file.id, schema.taskAttachment.fileId))
    .innerJoin(schema.folder, eq(schema.folder.id, schema.file.folderId))
    .where(and(eq(schema.file.projectId, projectId), inArray(schema.taskAttachment.taskId, visibleTaskIds), isNull(schema.file.deletedAt)));
  return new Set(rows.filter((r) => !r.gated || financials).map((r) => r.id));
}

/**
 * Delete files for good. The rows go first, in one statement that returns
 * exactly the versions it removed, so two purges at once can't both give the
 * same bytes back to the meter; then their bytes leave storage.
 */
export async function purgeFiles(conn: Database, fileIds: string[]): Promise<number> {
  if (fileIds.length === 0) return 0;
  const { versions, files } = await conn.transaction(async (tx) => {
    const versions = await tx.delete(schema.fileVersion).where(inArray(schema.fileVersion.fileId, fileIds)).returning();
    const files = await tx.delete(schema.file).where(inArray(schema.file.id, fileIds)).returning({ id: schema.file.id });
    return { versions, files };
  });
  const keys = versions.flatMap((x) => [x.objectKey, ...(x.thumbKey ? [x.thumbKey] : [])]);
  const bytes = versions.reduce((s, x) => s + x.sizeBytes + x.thumbBytes, 0);
  if (keys.length) await deleteStoredObjects(keys, bytes);
  return files.length;
}

/** Hourly: files in the trash longer than TRASH_DAYS are purged. */
export async function purgeTrashJob(conn: Database = db(), now = new Date()): Promise<{ purged: number }> {
  const cutoff = new Date(now.getTime() - TRASH_DAYS * 86_400_000);
  const old = await conn
    .select({ id: schema.file.id })
    .from(schema.file)
    .where(and(isNotNull(schema.file.deletedAt), lt(schema.file.deletedAt, cutoff)))
    .limit(200);
  return { purged: await purgeFiles(conn, old.map((r) => r.id)) };
}

/** Live files per folder (for the folder list). */
export async function folderCounts(conn: DbOrTx, folderIds: string[]): Promise<Map<string, { files: number; bytes: number }>> {
  const out = new Map<string, { files: number; bytes: number }>();
  if (folderIds.length === 0) return out;
  const rows = await conn
    .select({ folderId: schema.file.folderId, files: sql<number>`count(distinct ${schema.file.id})::int`, bytes: sql<number>`coalesce(sum(${schema.fileVersion.sizeBytes}), 0)::bigint` })
    .from(schema.file)
    .leftJoin(schema.fileVersion, and(eq(schema.fileVersion.fileId, schema.file.id), eq(schema.fileVersion.number, schema.file.currentVersion)))
    .where(and(inArray(schema.file.folderId, folderIds), isNull(schema.file.deletedAt)))
    .groupBy(schema.file.folderId);
  for (const r of rows) out.set(r.folderId, { files: r.files, bytes: Number(r.bytes) });
  return out;
}

/**
 * Of these people, who can see this folder right now: active, on the project
 * (or the owner), financial access for the gated folder, a share for
 * outsiders. Used for folder-watch notices, at creation and again at send.
 */
export async function canSeeFolderNow(conn: DbOrTx, projectId: string, folderId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const [folder] = await conn.select().from(schema.folder).where(and(eq(schema.folder.id, folderId), eq(schema.folder.projectId, projectId)));
  if (!folder) return new Set();
  const people = await conn
    .select({ userId: schema.user.id, role: schema.user.role, status: schema.user.status, member: schema.projectMember.userId, canViewFinancials: schema.projectMember.canViewFinancials })
    .from(schema.user)
    .leftJoin(schema.projectMember, and(eq(schema.projectMember.userId, schema.user.id), eq(schema.projectMember.projectId, projectId)))
    .where(inArray(schema.user.id, userIds));
  const shared = new Set(
    (await conn.select({ u: schema.folderShare.userId }).from(schema.folderShare).where(and(eq(schema.folderShare.folderId, folderId), inArray(schema.folderShare.userId, userIds)))).map((r) => r.u),
  );
  const out = new Set<string>();
  for (const p of people) {
    const actor = { userId: p.userId, role: p.role, status: p.status };
    const membership = p.member ? { projectRole: "", canViewFinancials: !!p.canViewFinancials, canEditChecklist: false, canApprove: false } : null;
    if (!canProject(actor, membership, "project.view")) continue;
    if (canSeeFolder(folder, { seesAll: canProject(actor, membership, "folder.viewAll"), financials: canProject(actor, membership, "financials.view"), shared: shared.has(p.userId) })) out.add(p.userId);
  }
  return out;
}
