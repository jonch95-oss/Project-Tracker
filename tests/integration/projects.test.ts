import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { GET as photoRoute } from "@/app/api/media/photos/[id]/route";
import { PUT as localUpload } from "@/app/api/uploads/local/route";
import { FREE_TIER_LIMITS } from "@/core/freeTier";
import { auth } from "@/server/auth";
import { db, schema } from "@/server/db";
import { cleanupAbandonedUploads } from "@/server/services/uploads";
import { storage } from "@/server/storage";
import { addMember, callerFor, companyId, createProject, createUser } from "../support/fixtures";

const PW = "correct horse battery 7";

async function signIn(email: string): Promise<string> {
  const res = await auth().handler(
    new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ email, password: PW }),
    }),
  );
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function uploadPhoto(caller: Awaited<ReturnType<typeof callerFor>>, projectId: string, bytes = { full: 1200, thumb: 300 }) {
  const b = await caller.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: bytes.full, thumbBytes: bytes.thumb, width: 2560, height: 1920 });
  for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(o.role === "full" ? bytes.full : bytes.thumb), { contentType: "image/webp" });
  return caller.photos.completeUpload({ projectId, uploadId: b.uploadId });
}

describe("projects", () => {
  let owner: Awaited<ReturnType<typeof createUser>>;
  beforeAll(async () => {
    owner = await createUser("owner");
  });

  it("create generates the type's phases, geocodes the address and fills a missing BBL", async () => {
    const c = await callerFor(owner.id);
    const { id } = await c.projects.create({ name: "Flip", address: "9 With BBL Street", type: "contract_flip", companyId: await companyId(), bbl: null });
    const p = await c.projects.get({ projectId: id });
    expect(p.phases.map((x) => x.key)).toEqual(["pipeline", "under_contract", "marketing", "assignment", "closed"]);
    expect(p.phases[0]).toMatchObject({ status: "active" });
    expect(p.latitude).toBeCloseTo(40.67, 1);
    expect(p.bbl).toBe("3011370045");
    // A BBL for another borough is not filled in.
    const q = await c.projects.create({ name: "Q", address: "9 With BBL Street", borough: "Queens", type: "gut_renovation", companyId: await companyId(), bbl: null });
    expect((await c.projects.get({ projectId: q.id })).bbl).toBeNull();
    // An address the city doesn't know still saves, just without a pin.
    const n = await c.projects.create({ name: "N", address: "1 Nowhere Lane", type: "gut_renovation", companyId: await companyId(), bbl: null });
    expect((await c.projects.get({ projectId: n.id })).latitude).toBeNull();
  });

  it("editing with a blank BBL fills it from the city's address data", async () => {
    const c = await callerFor(owner.id);
    const { id } = await c.projects.create({ name: "Later BBL", address: "5 With BBL Place", type: "gut_renovation", companyId: await companyId(), bbl: null });
    await db().update(schema.project).set({ bbl: null }).where(eq(schema.project.id, id));
    const p = await c.projects.get({ projectId: id });
    await c.projects.update({ projectId: id, version: p.version, name: p.name, address: p.address, borough: "Brooklyn", bbl: null, companyId: p.companyId, status: "active", facts: {} });
    expect((await c.projects.get({ projectId: id })).bbl).toBe("3011370045");
  });

  it("rejects a BBL whose borough digit doesn't match", async () => {
    const c = await callerFor(owner.id);
    await expect(
      c.projects.create({ name: "X", address: "1 A St", borough: "Manhattan", type: "gut_renovation", companyId: await companyId(), bbl: "3011370045" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("update uses optimistic locking and records what changed", async () => {
    const c = await callerFor(owner.id);
    const { id } = await createProject(owner.id, "Lock");
    const p = await c.projects.get({ projectId: id });
    const base = { projectId: id, name: p.name, address: p.address, borough: "Brooklyn" as const, bbl: null, companyId: p.companyId, status: "active" as const };
    const r = await c.projects.update({ ...base, version: p.version, facts: { units: 8, residFar: 2.43 } });
    expect(r.version).toBe(p.version + 1);
    await expect(c.projects.update({ ...base, version: p.version, facts: { units: 9 } })).rejects.toMatchObject({ code: "CONFLICT" });
    const after = await c.projects.get({ projectId: id });
    expect(after.units).toBe(8);
    expect(after.residFar).toBe(2.43);
    const feed = await c.projects.activity({ projectId: id });
    expect(feed.items[0]?.summary).toMatch(/edited Lock/);
  });

  it("phases: advance, go back, skip and restore, all under the version lock", async () => {
    const c = await callerFor(owner.id);
    const { id } = await createProject(owner.id, "Phases");
    let p = await c.projects.get({ projectId: id });
    await c.projects.setPhase({ projectId: id, key: "closing", version: p.version });
    p = await c.projects.get({ projectId: id });
    expect(p.phases.find((x) => x.status === "active")?.key).toBe("closing");
    expect(p.phases.filter((x) => x.status === "done").map((x) => x.key)).toEqual(["pipeline", "under_contract", "due_diligence"]);
    await expect(c.projects.setPhase({ projectId: id, key: "construction", version: p.version - 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(c.projects.skipPhase({ projectId: id, key: "closing", skipped: true, version: p.version })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await c.projects.skipPhase({ projectId: id, key: "ag_plan_sales", skipped: true, version: p.version });
    p = await c.projects.get({ projectId: id });
    await expect(c.projects.setPhase({ projectId: id, key: "ag_plan_sales", version: p.version })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await c.projects.setPhase({ projectId: id, key: "under_contract", version: p.version });
    p = await c.projects.get({ projectId: id });
    expect(p.phases.find((x) => x.key === "closing")).toMatchObject({ status: "pending", startedOn: null });
    expect(p.phases.find((x) => x.key === "ag_plan_sales")?.status).toBe("skipped");
  });

  it("archive hides a project from the portfolio and restore brings it back", async () => {
    const c = await callerFor(owner.id);
    const { id } = await createProject(owner.id, "Archive me");
    await c.projects.setArchived({ projectId: id, archived: true });
    expect((await c.projects.list()).projects.some((p) => p.id === id)).toBe(false);
    expect((await c.projects.list({ archived: true })).projects.some((p) => p.id === id)).toBe(true);
    await c.projects.setArchived({ projectId: id, archived: false });
    expect((await c.projects.list()).projects.some((p) => p.id === id)).toBe(true);
  });

  it("headline financials reach only people with the flag: list, get and activity", async () => {
    const c = await callerFor(owner.id);
    const { id } = await createProject(owner.id, "Money");
    await c.projects.setHeadline({ projectId: id, purchasePriceCents: 2_500_000_00, totalBudgetCents: 4_000_000_00, projectedSelloutCents: 7_000_000_00 });
    const fin = await createUser("member");
    const noFin = await createUser("member");
    const ext = await createUser("external");
    await addMember(id, fin.id, { canViewFinancials: true });
    await addMember(id, noFin.id);
    await addMember(id, ext.id);

    const asFin = await callerFor(fin.id);
    expect((await asFin.projects.get({ projectId: id })).headline?.purchasePriceCents).toBe(2_500_000_00);
    expect((await asFin.projects.list()).projects.find((p) => p.id === id)?.headline?.projectedSelloutCents).toBe(7_000_000_00);
    expect((await asFin.projects.activity({ projectId: id })).items.some((e) => e.entityType === "project_headline")).toBe(true);

    const asNo = await callerFor(noFin.id);
    expect((await asNo.projects.get({ projectId: id })).headline).toBeNull();
    expect((await asNo.projects.list()).projects.find((p) => p.id === id)?.headline).toBeNull();
    const feed = await asNo.projects.activity({ projectId: id });
    expect(feed.items.length).toBeGreaterThan(0);
    expect(feed.items.some((e) => e.entityType === "project_headline")).toBe(false);
    expect(JSON.stringify(feed)).not.toMatch(/250000000|2,500,000/);
    await expect(asNo.projects.setHeadline({ projectId: id, purchasePriceCents: 1, totalBudgetCents: null, projectedSelloutCents: null })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Outside collaborators: no headline, no activity feed, and no view of who else is on projects.
    const asExt = await callerFor(ext.id);
    expect((await asExt.projects.get({ projectId: id })).headline).toBeNull();
    await expect(asExt.projects.activity({ projectId: id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const extList = await asExt.projects.list();
    expect(extList.people).toEqual([]);
    expect(extList.projects.find((p) => p.id === id)?.memberIds).toEqual([]);
  });

  it("the person filter lists members of visible projects only", async () => {
    const admin = await createUser("admin");
    const { id } = await createProject(owner.id, "People");
    await addMember(id, admin.id);
    const stranger = await createUser("member", { name: "Not On Anything" });
    const list = await (await callerFor(admin.id)).projects.list();
    expect(list.people.some((p) => p.id === admin.id)).toBe(true);
    expect(list.people.some((p) => p.id === stranger.id)).toBe(false);
  });
});

describe("photos", () => {
  let owner: Awaited<ReturnType<typeof createUser>>;
  let member: Awaited<ReturnType<typeof createUser>>;
  let projectId: string;
  beforeAll(async () => {
    owner = await createUser("owner", { password: PW });
    member = await createUser("member", { password: PW });
    projectId = (await createProject(owner.id, "Photos")).id;
    await addMember(projectId, member.id);
  });

  it("upload is verified against what was authorized, metered, and the newest photo is the hero", async () => {
    const c = await callerFor(member.id);
    const before = await db().select().from(schema.usageCounter).where(eq(schema.usageCounter.key, "blob.storage"));
    const first = await uploadPhoto(c, projectId);
    const second = await uploadPhoto(c, projectId);
    const after = await db().select().from(schema.usageCounter).where(eq(schema.usageCounter.key, "blob.storage"));
    expect((after[0]?.value ?? 0) - (before[0]?.value ?? 0)).toBe(3000);
    const p = await c.projects.get({ projectId });
    expect(p.hero?.id).toBe(second.id);
    // Pinning (admin/owner only) overrides "newest".
    await expect(c.photos.setHero({ projectId, photoId: first.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await (await callerFor(owner.id)).photos.setHero({ projectId, photoId: first.id });
    expect((await c.projects.get({ projectId })).hero?.id).toBe(first.id);
    expect((await c.projects.list()).projects.find((x) => x.id === projectId)?.hero?.id).toBe(first.id);
  });

  it("refuses a completed upload that is bigger than authorized, missing, or of another type", async () => {
    const c = await callerFor(member.id);
    const b = await c.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: 100, thumbBytes: 10, width: 10, height: 10 });
    await expect(c.photos.completeUpload({ projectId, uploadId: b.uploadId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(o.role === "full" ? 101 : 10), { contentType: "image/webp" });
    await expect(c.photos.completeUpload({ projectId, uploadId: b.uploadId })).rejects.toMatchObject({ message: /didn't match/ });
    // The oversized objects were deleted, not kept.
    expect(await storage().head(b.objects[0]!.pathname)).toBeNull();

    const t = await c.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: 100, thumbBytes: 10, width: 10, height: 10 });
    for (const o of t.objects) await storage().put(o.pathname, new Uint8Array(10), { contentType: "text/html" });
    await expect(c.photos.completeUpload({ projectId, uploadId: t.uploadId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("an upload belongs to the user who began it, once, before it expires", async () => {
    const c = await callerFor(member.id);
    const b = await c.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: 10, thumbBytes: 5, width: 4, height: 3 });
    for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(o.role === "full" ? 10 : 5), { contentType: "image/webp" });
    await expect((await callerFor(owner.id)).photos.completeUpload({ projectId, uploadId: b.uploadId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await c.photos.completeUpload({ projectId, uploadId: b.uploadId });
    await expect(c.photos.completeUpload({ projectId, uploadId: b.uploadId })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const e = await c.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: 10, thumbBytes: 5, width: 4, height: 3 });
    await db().update(schema.pendingUpload).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.pendingUpload.id, e.uploadId));
    await expect(c.photos.completeUpload({ projectId, uploadId: e.uploadId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("the hourly cleanup deletes objects left by abandoned uploads", async () => {
    const c = await callerFor(member.id);
    const b = await c.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: 10, thumbBytes: 5, width: 4, height: 3 });
    await storage().put(b.objects[0]!.pathname, new Uint8Array(10), { contentType: "image/webp" });
    await db().update(schema.pendingUpload).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.pendingUpload.id, b.uploadId));
    const r = await cleanupAbandonedUploads();
    expect(r.abandoned).toBeGreaterThanOrEqual(1);
    expect(await storage().head(b.objects[0]!.pathname)).toBeNull();
    const [row] = await db().select().from(schema.pendingUpload).where(eq(schema.pendingUpload.id, b.uploadId));
    expect(row).toBeUndefined();
  });

  it("refuses uploads past 95% of the Blob budget", async () => {
    const limit = FREE_TIER_LIMITS["blob.storage"].limit;
    await db()
      .insert(schema.usageCounter)
      .values({ key: "blob.storage", periodKey: "total", value: Math.floor(limit * 0.95) })
      .onConflictDoUpdate({ target: [schema.usageCounter.key, schema.usageCounter.periodKey], set: { value: Math.floor(limit * 0.95) } });
    const c = await callerFor(member.id);
    await expect(c.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: 10, thumbBytes: 5, width: 4, height: 3 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await db().update(schema.usageCounter).set({ value: 0 }).where(eq(schema.usageCounter.key, "blob.storage"));
  });

  it("removing: uploader or admin only; storage and meter are released; a pinned hero is unpinned", async () => {
    const mc = await callerFor(member.id);
    const oc = await callerFor(owner.id);
    const other = await createUser("member");
    await addMember(projectId, other.id);
    const mine = await uploadPhoto(mc, projectId, { full: 500, thumb: 50 });
    await expect((await callerFor(other.id)).photos.remove({ projectId, photoId: mine.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await oc.photos.setHero({ projectId, photoId: mine.id });
    const [row] = await db().select().from(schema.projectPhoto).where(eq(schema.projectPhoto.id, mine.id));
    await mc.photos.remove({ projectId, photoId: mine.id });
    expect(await storage().head(row!.objectKey)).toBeNull();
    expect(await storage().head(row!.thumbKey)).toBeNull();
    expect((await oc.projects.get({ projectId })).heroPhotoId).toBeNull();
  });

  it("two simultaneous completes record the photo once and meter it once; two removes release it once", async () => {
    const c = await callerFor(member.id);
    const b = await c.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: 1000, thumbBytes: 100, width: 4, height: 3 });
    for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(o.role === "full" ? 1000 : 100), { contentType: "image/webp" });
    const meter = async () => (await db().select().from(schema.usageCounter).where(eq(schema.usageCounter.key, "blob.storage")))[0]?.value ?? 0;
    const before = await meter();
    const results = await Promise.allSettled([c.photos.completeUpload({ projectId, uploadId: b.uploadId }), c.photos.completeUpload({ projectId, uploadId: b.uploadId })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await db().select().from(schema.projectPhoto).where(eq(schema.projectPhoto.objectKey, b.objects[0]!.pathname));
    expect(rows).toHaveLength(1);
    expect((await meter()) - before).toBe(1100);

    const oc = await callerFor(owner.id);
    const removed = await Promise.allSettled([oc.photos.remove({ projectId, photoId: rows[0]!.id }), oc.photos.remove({ projectId, photoId: rows[0]!.id })]);
    expect(removed.some((r) => r.status === "fulfilled")).toBe(true);
    expect((await meter()) - before).toBe(0);
  });

  it("uploads still in flight count toward the 95% stop", async () => {
    const limit = FREE_TIER_LIMITS["blob.storage"].limit;
    const c = await callerFor(member.id);
    // Leave just under 25 MB of headroom below 95%, then reserve two 12 MB uploads without finishing them.
    const start = Math.floor(limit * 0.95) - 25 * 1024 * 1024;
    await db()
      .insert(schema.usageCounter)
      .values({ key: "blob.storage", periodKey: "total", value: start })
      .onConflictDoUpdate({ target: [schema.usageCounter.key, schema.usageCounter.periodKey], set: { value: start } });
    const big = 12 * 1024 * 1024;
    await c.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: big - 1024, thumbBytes: 1024, width: 4, height: 3 });
    await c.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: big - 1024, thumbBytes: 1024, width: 4, height: 3 });
    await expect(c.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: big - 1024, thumbBytes: 1024, width: 4, height: 3 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await db().update(schema.usageCounter).set({ value: 0 }).where(eq(schema.usageCounter.key, "blob.storage"));
    await db().delete(schema.pendingUpload).where(eq(schema.pendingUpload.userId, member.id));
  });

  it("the photo route serves only to people on the project, with private caching", async () => {
    const c = await callerFor(member.id);
    const photo = await uploadPhoto(c, projectId, { full: 64, thumb: 16 });
    const cookie = await signIn(member.email);
    const ok = await photoRoute(new Request(`http://localhost:3000/api/media/photos/${photo.id}?size=full`, { headers: { cookie } }), {
      params: Promise.resolve({ id: photo.id }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.arrayBuffer()).byteLength).toBe(64);
    expect(ok.headers.get("cache-control")).toBe("private, max-age=600");
    const thumb = await photoRoute(new Request(`http://localhost:3000/api/media/photos/${photo.id}`, { headers: { cookie } }), { params: Promise.resolve({ id: photo.id }) });
    expect((await thumb.arrayBuffer()).byteLength).toBe(16);

    const outsider = await createUser("member", { password: PW });
    const oc = await signIn(outsider.email);
    const denied = await photoRoute(new Request(`http://localhost:3000/api/media/photos/${photo.id}`, { headers: { cookie: oc } }), { params: Promise.resolve({ id: photo.id }) });
    expect(denied.status).toBe(404);
    const anon = await photoRoute(new Request(`http://localhost:3000/api/media/photos/${photo.id}`), { params: Promise.resolve({ id: photo.id }) });
    expect(anon.status).toBe(401);
    const junk = await photoRoute(new Request(`http://localhost:3000/api/media/photos/x`, { headers: { cookie } }), { params: Promise.resolve({ id: "../etc" }) });
    expect(junk.status).toBe(404);
  });

  it("the local upload stand-in enforces the same authorization", async () => {
    const c = await callerFor(member.id);
    const b = await c.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: 8, thumbBytes: 4, width: 4, height: 3 });
    const cookie = await signIn(member.email);
    const put = (path: string, body: Uint8Array, type = "image/webp", ck = cookie) =>
      localUpload(new Request(`http://localhost:3000/api/uploads/local?upload=${b.uploadId}&path=${encodeURIComponent(path)}`, { method: "PUT", headers: { cookie: ck, "content-type": type }, body: new Blob([body as BlobPart]) }));
    expect((await put(b.objects[0]!.pathname, new Uint8Array(8))).status).toBe(200);
    expect((await put(b.objects[1]!.pathname, new Uint8Array(5))).status).toBe(400); // over its limit
    expect((await put(b.objects[1]!.pathname, new Uint8Array(4), "text/html")).status).toBe(400);
    expect((await put(`projects/${projectId}/photos/evil.webp`, new Uint8Array(4))).status).toBe(403);
    const ownerCookie = await signIn(owner.email);
    expect((await put(b.objects[1]!.pathname, new Uint8Array(4), "image/webp", ownerCookie)).status).toBe(403);
  });
});
