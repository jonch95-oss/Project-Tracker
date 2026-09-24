import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "@/core/files";
import { db, schema } from "@/server/db";
import { purgeTrashJob } from "@/server/services/files";
import { setScannerForTests } from "@/server/services/scan";
import { storage } from "@/server/storage";
import { addMember, callerFor, companyId, createUser } from "../support/fixtures";

type Caller = Awaited<ReturnType<typeof callerFor>>;

async function newProject(c: Caller) {
  return c.projects.create({ name: `Files ${Math.random().toString(36).slice(2, 7)}`, address: "7 File Street", type: "gut_renovation", companyId: await companyId(), bbl: null, toggles: [] });
}

/** Upload through the real begin → put → complete path (memory storage stands in for Blob). */
async function upload(c: Caller, projectId: string, target: { folderId?: string; fileId?: string; taskId?: string }, name = "plan.pdf", bytes = 1000, type = "application/pdf") {
  const b = await c.files.beginUpload({ projectId, ...target, name, contentType: type, sizeBytes: bytes });
  for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(bytes), { contentType: o.contentType });
  return c.files.completeUpload({ projectId, uploadId: b.uploadId });
}

const folderNamed = async (c: Caller, projectId: string, name: string) => (await c.files.folders({ projectId })).folders.find((f) => f.name === name)!;

describe("files", () => {
  let owner: Awaited<ReturnType<typeof createUser>>;
  let member: Awaited<ReturnType<typeof createUser>>;
  let finMember: Awaited<ReturnType<typeof createUser>>;
  let outsider: Awaited<ReturnType<typeof createUser>>;
  let admin: Awaited<ReturnType<typeof createUser>>;
  let oc: Caller, mc: Caller, fc: Caller, xc: Caller, ac: Caller;
  let projectId: string;

  beforeAll(async () => {
    owner = await createUser("owner");
    member = await createUser("member", { name: "Mo Member" });
    finMember = await createUser("member", { name: "Fin Member" });
    outsider = await createUser("external", { name: "Arch Itect" });
    admin = await createUser("admin");
    oc = await callerFor(owner.id);
    mc = await callerFor(member.id);
    fc = await callerFor(finMember.id);
    xc = await callerFor(outsider.id);
    ac = await callerFor(admin.id);
    projectId = (await newProject(oc)).id;
    await addMember(projectId, member.id);
    await addMember(projectId, finMember.id, { canViewFinancials: true });
    await addMember(projectId, outsider.id);
    await addMember(projectId, admin.id, { canEditChecklist: true, canApprove: true });
  });

  afterEach(() => setScannerForTests(null));

  it("a new project gets the template's folders; Financial is gated", async () => {
    const all = await oc.files.folders({ projectId });
    expect(all.folders.map((f) => f.name)).toEqual(["Acquisition", "Legal", "Title & Survey", "Environmental", "Design", "DOB & Permits", "Construction", "Photos", "Financial", "Sales", "Closeout"]);
    expect(all.folders.find((f) => f.name === "Financial")!.gated).toBe(true);
    expect((await mc.files.folders({ projectId })).folders.some((f) => f.name === "Financial")).toBe(false);
    expect((await fc.files.folders({ projectId })).folders.some((f) => f.name === "Financial")).toBe(true);
    // Outsiders see nothing until something is shared.
    expect((await xc.files.folders({ projectId })).folders).toHaveLength(0);
  });

  it("upload, new version, list, rename with a stale-edit check, move, trash, restore, purge", async () => {
    const legal = await folderNamed(mc, projectId, "Legal");
    const { fileId } = await upload(mc, projectId, { folderId: legal.id }, "Contract of sale.pdf", 2000);
    const v2 = await upload(mc, projectId, { fileId }, "Contract of sale (signed).pdf", 3000);
    expect(v2.number).toBe(2);
    const list = await mc.files.list({ projectId, folderId: legal.id });
    expect(list.find((f) => f.id === fileId)).toMatchObject({ name: "Contract of sale.pdf", currentVersion: 2, sizeBytes: 3000, preview: "pdf" });
    const got = await mc.files.get({ projectId, fileId });
    expect(got.versions.map((v) => v.number)).toEqual([2, 1]);
    expect(got.access.canManage).toBe(true);

    await mc.files.rename({ projectId, fileId, version: got.version, name: "Contract.pdf" });
    await expect(mc.files.rename({ projectId, fileId, version: got.version, name: "Stale" })).rejects.toMatchObject({ code: "CONFLICT" });
    const design = await folderNamed(mc, projectId, "Design");
    await mc.files.move({ projectId, fileId, version: got.version + 1, folderId: design.id });
    expect((await mc.files.list({ projectId, folderId: design.id })).some((f) => f.id === fileId)).toBe(true);

    // Someone else's file: members without checklist rights can't manage it.
    const other = await upload(fc, projectId, { folderId: design.id }, "Survey.dwg", 500, "application/octet-stream");
    await expect(mc.files.remove({ projectId, fileId: other.fileId })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await mc.files.remove({ projectId, fileId });
    expect((await mc.files.list({ projectId, folderId: design.id })).some((f) => f.id === fileId)).toBe(false);
    expect((await ac.files.trash({ projectId })).some((f) => f.id === fileId)).toBe(true);
    await ac.files.restore({ projectId, fileId });
    expect((await mc.files.list({ projectId, folderId: design.id })).some((f) => f.id === fileId)).toBe(true);

    const keys = (await db().select().from(schema.fileVersion).where(eq(schema.fileVersion.fileId, fileId))).map((v) => v.objectKey);
    await mc.files.remove({ projectId, fileId });
    await expect(mc.files.purge({ projectId, fileId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await ac.files.purge({ projectId, fileId });
    for (const k of keys) expect(await storage().head(k)).toBeNull();
    expect(await db().select().from(schema.file).where(eq(schema.file.id, fileId))).toHaveLength(0);
  });

  it("the trash empties itself after 30 days", async () => {
    const f = await folderNamed(mc, projectId, "Sales");
    const { fileId } = await upload(mc, projectId, { folderId: f.id });
    await mc.files.remove({ projectId, fileId });
    await db().update(schema.file).set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(schema.file.id, fileId));
    const r = await purgeTrashJob();
    expect(r.purged).toBeGreaterThanOrEqual(1);
    expect(await db().select().from(schema.file).where(eq(schema.file.id, fileId))).toHaveLength(0);
  });

  it("the Financial folder is invisible without financial access, including names in activity and moves", async () => {
    const fin = await folderNamed(fc, projectId, "Financial");
    const { fileId } = await upload(fc, projectId, { folderId: fin.id }, "Lender term sheet.pdf");
    await expect(mc.files.get({ projectId, fileId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(mc.files.list({ projectId, folderId: fin.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(mc.files.beginUpload({ projectId, folderId: fin.id, name: "x.pdf", contentType: "application/pdf", sizeBytes: 10 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A file moved in from a normal folder disappears for them too, and the move isn't in their activity.
    const acq = await folderNamed(fc, projectId, "Acquisition");
    const moved = await upload(fc, projectId, { folderId: acq.id }, "Purchase price analysis.xlsx", 100, "application/vnd.ms-excel");
    await fc.files.move({ projectId, fileId: moved.fileId, version: 1, folderId: fin.id });
    await expect(mc.files.get({ projectId, fileId: moved.fileId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const act = await mc.projects.activity({ projectId });
    expect(JSON.stringify(act)).not.toMatch(/Lender term sheet|moved Purchase price analysis/);
    const actFin = await fc.projects.activity({ projectId });
    expect(JSON.stringify(actFin)).toMatch(/Lender term sheet/);
    // Members without financial access can't move files into it.
    const own = await upload(mc, projectId, { folderId: acq.id }, "Mine.pdf");
    await expect(mc.files.move({ projectId, fileId: own.fileId, version: 1, folderId: fin.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("outside collaborators see and add to only the folders shared with them", async () => {
    const design = await folderNamed(oc, projectId, "Design");
    const legal = await folderNamed(oc, projectId, "Legal");
    const secret = await upload(mc, projectId, { folderId: legal.id }, "Operating agreement.pdf");
    await expect(mc.files.shareFolder({ projectId, folderId: design.id, userId: outsider.id, on: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await ac.files.shareFolder({ projectId, folderId: design.id, userId: outsider.id, on: true });
    const seen = await xc.files.folders({ projectId });
    expect(seen.folders.map((f) => f.name)).toEqual(["Design"]);
    expect(seen.folders[0]!.sharedWith).toEqual([]); // they don't see who else it's shared with
    const { fileId } = await upload(xc, projectId, { folderId: design.id }, "A-101 plans.pdf");
    expect((await mc.files.list({ projectId, folderId: design.id })).some((f) => f.id === fileId)).toBe(true);
    await expect(xc.files.get({ projectId, fileId: secret.fileId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(xc.files.beginUpload({ projectId, folderId: legal.id, name: "x.pdf", contentType: "application/pdf", sizeBytes: 10 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The gated folder can't be shared with someone lacking financial access; internal people don't need shares.
    const fin = await folderNamed(oc, projectId, "Financial");
    await expect(oc.files.shareFolder({ projectId, folderId: fin.id, userId: outsider.id, on: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(oc.files.shareFolder({ projectId, folderId: design.id, userId: member.id, on: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Unshare: gone.
    await ac.files.shareFolder({ projectId, folderId: design.id, userId: outsider.id, on: false });
    await expect(xc.files.get({ projectId, fileId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("site photos follow the Photos folder for outsiders", async () => {
    expect(await xc.photos.list({ projectId })).toEqual([]);
    await expect(xc.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: 10, thumbBytes: 5, width: 4, height: 3 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const photos = await folderNamed(oc, projectId, "Photos");
    await oc.files.shareFolder({ projectId, folderId: photos.id, userId: outsider.id, on: true });
    const b = await xc.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: 10, thumbBytes: 5, width: 4, height: 3 });
    for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(o.role === "full" ? 10 : 5), { contentType: "image/webp" });
    await xc.photos.completeUpload({ projectId, uploadId: b.uploadId });
    expect((await xc.photos.list({ projectId })).length).toBeGreaterThanOrEqual(1);
    expect((await xc.projects.get({ projectId })).access.canUploadPhotos).toBe(true);
    await oc.files.shareFolder({ projectId, folderId: photos.id, userId: outsider.id, on: false });
  });

  it("task attachments: shown on the task to whoever sees the task, never gated files without access; required attachments route to the attach step", async () => {
    const legal = await folderNamed(oc, projectId, "Legal");
    const [t] = await db().insert(schema.task).values({ projectId, phaseKey: "pipeline", title: "Upload the signed LOI", assigneeId: outsider.id, requiredAttachment: "Signed LOI" }).returning();
    // One-tap complete needs the attachment first.
    const r = await xc.checklist.setDone({ projectId, taskId: t!.id, done: true, version: 1 });
    expect(r).toMatchObject({ status: "needs_attachment", label: "Signed LOI" });
    // The outsider uploads onto their task (into a folder they can't browse? no: they need a visible folder).
    await expect(upload(xc, projectId, { folderId: legal.id, taskId: t!.id }, "LOI.pdf")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The team attaches a Legal file to the task; the outsider sees it there, not in Legal.
    const loi = await upload(mc, projectId, { folderId: legal.id, taskId: t!.id }, "LOI signed.pdf");
    const onTask = await xc.files.forTask({ projectId, taskId: t!.id });
    expect(onTask.map((f) => f.id)).toEqual([loi.fileId]);
    expect(onTask[0]!.folderName).toBeNull();
    const seen = await xc.files.get({ projectId, fileId: loi.fileId });
    expect(seen.folder).toBeNull();
    expect(seen.access).toEqual({ canManage: false, canAddVersion: false });
    // A gated file attached to the task stays hidden from them.
    const fin = await folderNamed(fc, projectId, "Financial");
    const gated = await upload(fc, projectId, { folderId: fin.id, taskId: t!.id }, "Wire instructions.pdf");
    expect((await xc.files.forTask({ projectId, taskId: t!.id })).map((f) => f.id)).toEqual([loi.fileId]);
    await expect(xc.files.get({ projectId, fileId: gated.fileId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Now it completes.
    const done = await xc.checklist.setDone({ projectId, taskId: t!.id, done: true, version: 1 });
    expect(done.status).toBe("done");
    // Trashed attachments don't count.
    const [t2] = await db().insert(schema.task).values({ projectId, phaseKey: "pipeline", title: "Needs survey", requiredAttachment: "Survey" }).returning();
    const s = await upload(mc, projectId, { folderId: legal.id, taskId: t2!.id }, "Survey.pdf");
    await mc.files.remove({ projectId, fileId: s.fileId });
    expect((await mc.checklist.setDone({ projectId, taskId: t2!.id, done: true, version: 1 })).status).toBe("needs_attachment");
    // Attach an existing file, then detach.
    await mc.files.attach({ projectId, taskId: t2!.id, fileId: loi.fileId });
    expect((await mc.files.forTask({ projectId, taskId: t2!.id })).map((f) => f.id)).toEqual([loi.fileId]);
    await mc.files.detach({ projectId, taskId: t2!.id, fileId: loi.fileId });
    expect(await mc.files.forTask({ projectId, taskId: t2!.id })).toEqual([]);
  });

  it("the virus-scan hook rejects infected files and deletes their bytes", async () => {
    setScannerForTests({ scan: async () => "infected" });
    const f = await folderNamed(mc, projectId, "Construction");
    const b = await mc.files.beginUpload({ projectId, folderId: f.id, name: "invoice.exe", contentType: "application/octet-stream", sizeBytes: 50 });
    for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(50), { contentType: o.contentType });
    await expect(mc.files.completeUpload({ projectId, uploadId: b.uploadId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    for (const o of b.objects) expect(await storage().head(o.pathname)).toBeNull();
    expect((await mc.files.list({ projectId, folderId: f.id })).some((x) => x.name === "invoice.exe")).toBe(false);
    setScannerForTests({ scan: async () => "clean" });
    const ok = await upload(mc, projectId, { folderId: f.id }, "clean.pdf");
    expect(ok.scanStatus).toBe("clean");
  });

  it("limits: 500 MB per file, bytes must match what was authorized, one completion per upload", async () => {
    const f = await folderNamed(mc, projectId, "Closeout");
    await expect(mc.files.beginUpload({ projectId, folderId: f.id, name: "huge.mov", contentType: "video/quicktime", sizeBytes: MAX_FILE_BYTES + 1 })).rejects.toBeTruthy();
    const b = await mc.files.beginUpload({ projectId, folderId: f.id, name: "a.pdf", contentType: "application/pdf", sizeBytes: 10 });
    await storage().put(b.objects[0]!.pathname, new Uint8Array(20), { contentType: "application/pdf" });
    await expect(mc.files.completeUpload({ projectId, uploadId: b.uploadId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const ok = await mc.files.beginUpload({ projectId, folderId: f.id, name: "b.pdf", contentType: "application/pdf", sizeBytes: 10 });
    await storage().put(ok.objects[0]!.pathname, new Uint8Array(10), { contentType: "application/pdf" });
    await mc.files.completeUpload({ projectId, uploadId: ok.uploadId });
    await expect(mc.files.completeUpload({ projectId, uploadId: ok.uploadId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Someone else can't complete my upload.
    const mine = await mc.files.beginUpload({ projectId, folderId: f.id, name: "c.pdf", contentType: "application/pdf", sizeBytes: 10 });
    await expect(fc.files.completeUpload({ projectId, uploadId: mine.uploadId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("folders: editors add, rename and remove empty ones; Financial and Photos stay", async () => {
    await expect(mc.files.createFolder({ projectId, name: "Insurance" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { id } = await ac.files.createFolder({ projectId, name: "Insurance" });
    await expect(ac.files.createFolder({ projectId, name: "insurance" })).rejects.toMatchObject({ code: "CONFLICT" });
    await ac.files.renameFolder({ projectId, folderId: id, name: "Insurance & COIs" });
    const up = await upload(ac, projectId, { folderId: id }, "COI.pdf");
    await expect(ac.files.deleteFolder({ projectId, folderId: id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await ac.files.remove({ projectId, fileId: up.fileId });
    await expect(ac.files.deleteFolder({ projectId, folderId: id })).rejects.toMatchObject({ code: "BAD_REQUEST" }); // still in the trash
    await ac.files.purge({ projectId, fileId: up.fileId });
    await ac.files.deleteFolder({ projectId, folderId: id });
    const fin = await folderNamed(oc, projectId, "Financial");
    await expect(oc.files.deleteFolder({ projectId, folderId: fin.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("leaving a project ends folder shares", async () => {
    const gc = await createUser("external");
    await addMember(projectId, gc.id);
    const d = await folderNamed(oc, projectId, "Construction");
    await oc.files.shareFolder({ projectId, folderId: d.id, userId: gc.id, on: true });
    await oc.members.remove({ projectId, userId: gc.id });
    expect(await db().select().from(schema.folderShare).where(and(eq(schema.folderShare.userId, gc.id)))).toHaveLength(0);
  });
});
