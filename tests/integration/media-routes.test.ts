/**
 * File URLs in the permission matrix (brief §13): the download routes check
 * access on every request, for every role, exactly like the Files tab.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { storage } from "@/server/storage";
import { addMember, callerFor, companyId, contextFor, createUser } from "../support/fixtures";

// The routes read the session from the request; here it's whoever `as` names.
let as: string | null = null;
vi.mock("@/server/request-context", () => ({
  authedContextFrom: async () => {
    const c = await contextFor(as);
    return c.viewer ? c : null;
  },
}));

const { GET: fileRoute } = await import("@/app/api/media/files/[id]/route");
const { GET: photoRoute } = await import("@/app/api/media/photos/[id]/route");

const openFile = (versionId: string, query = "") => fileRoute(new Request(`http://t/api/media/files/${versionId}${query}`), { params: Promise.resolve({ id: versionId }) } as never);
const openPhoto = (id: string) => photoRoute(new Request(`http://t/api/media/photos/${id}`), { params: Promise.resolve({ id }) } as never);

describe("download routes", () => {
  const u = {} as Record<"owner" | "member" | "memberFin" | "outsider" | "outsiderShared" | "stranger", string>;
  let plainVersion: string, gatedVersion: string, htmlVersion: string, photoId: string;

  beforeAll(async () => {
    u.owner = (await createUser("owner")).id;
    for (const k of ["member", "memberFin", "stranger"] as const) u[k] = (await createUser("member")).id;
    for (const k of ["outsider", "outsiderShared"] as const) u[k] = (await createUser("external")).id;
    const oc = await callerFor(u.owner);
    const { id: projectId } = await oc.projects.create({ name: "Media", address: "9 Media St", type: "gut_renovation", companyId: await companyId(), bbl: null, toggles: [] });
    await addMember(projectId, u.member);
    await addMember(projectId, u.memberFin, { canViewFinancials: true });
    await addMember(projectId, u.outsider);
    await addMember(projectId, u.outsiderShared);
    const folders = (await oc.files.folders({ projectId })).folders;
    const design = folders.find((f) => f.name === "Design")!;
    const fin = folders.find((f) => f.name === "Financial")!;
    const photos = folders.find((f) => f.name === "Photos")!;
    await oc.files.shareFolder({ projectId, folderId: design.id, userId: u.outsiderShared, on: true });
    await oc.files.shareFolder({ projectId, folderId: photos.id, userId: u.outsiderShared, on: true });
    const up = async (folderId: string, name: string, type: string) => {
      const b = await oc.files.beginUpload({ projectId, folderId, name, contentType: type, sizeBytes: 5 });
      for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(5), { contentType: o.contentType });
      const r = await oc.files.completeUpload({ projectId, uploadId: b.uploadId });
      return (await oc.files.get({ projectId, fileId: r.fileId })).versions[0]!.id;
    };
    plainVersion = await up(design.id, "plans.pdf", "application/pdf");
    gatedVersion = await up(fin.id, "wire.pdf", "application/pdf");
    htmlVersion = await up(design.id, "page.html", "text/html");
    const pb = await oc.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: 5, thumbBytes: 5, width: 2, height: 2 });
    for (const o of pb.objects) await storage().put(o.pathname, new Uint8Array(5), { contentType: "image/webp" });
    photoId = (await oc.photos.completeUpload({ projectId, uploadId: pb.uploadId })).id;
  });

  const cases: [keyof typeof u | "anon", { plain: number; gated: number; photo: number }][] = [
    ["anon", { plain: 401, gated: 401, photo: 401 }],
    ["owner", { plain: 200, gated: 200, photo: 200 }],
    ["member", { plain: 200, gated: 404, photo: 200 }],
    ["memberFin", { plain: 200, gated: 200, photo: 200 }],
    ["outsider", { plain: 404, gated: 404, photo: 404 }],
    ["outsiderShared", { plain: 200, gated: 404, photo: 200 }],
    ["stranger", { plain: 404, gated: 404, photo: 404 }],
  ];
  for (const [who, want] of cases) {
    it(`${who}: file ${want.plain}, gated file ${want.gated}, photo ${want.photo}`, async () => {
      as = who === "anon" ? null : u[who];
      expect((await openFile(plainVersion)).status).toBe(want.plain);
      expect((await openFile(gatedVersion)).status).toBe(want.gated);
      expect((await openPhoto(photoId)).status).toBe(want.photo);
    });
  }

  it("anything that isn't an image or PDF is a plain download, never rendered", async () => {
    as = u.owner;
    const r = await openFile(htmlVersion);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const pdf = await openFile(plainVersion);
    expect(pdf.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(pdf.headers.get("cache-control")).toBe("private, no-store");
  });
});
