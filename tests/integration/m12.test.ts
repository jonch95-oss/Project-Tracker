/**
 * Milestone 12 (brief §12): camera photos keep when and, if the person chose,
 * where they were taken.
 */
import { describe, expect, it } from "vitest";
import { storage } from "@/server/storage";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import {
  addMember,
  callerFor,
  createProject,
  createUser,
} from "../support/fixtures";

describe("Milestone 12: photo capture", () => {
  it("saves the capture time and an optional location; bad coordinates are refused", async () => {
    const owner = await createUser("owner");
    const c = await callerFor(owner.id);
    const { id: projectId } = await createProject(
      owner.id,
      `M12 ${Date.now()}`,
    );
    const up = async (
      location?: {
        latitude: number;
        longitude: number;
        accuracyM?: number | null;
      } | null,
    ) => {
      const b = await c.photos.beginUpload({
        projectId,
        contentType: "image/jpeg",
        fullBytes: 20,
        thumbBytes: 5,
        width: 4,
        height: 3,
        takenAt: new Date("2026-09-24T14:15:00Z"),
        location,
      });
      for (const o of b.objects)
        await storage().put(
          o.pathname,
          new Uint8Array(o.role === "full" ? 20 : 5),
          { contentType: "image/jpeg" },
        );
      return (
        await c.photos.completeUpload({ projectId, uploadId: b.uploadId })
      ).id;
    };
    const located = await up({
      latitude: 40.68921,
      longitude: -73.94421,
      accuracyM: 12.4,
    });
    const plain = await up(null);
    const list = await c.photos.list({ projectId });
    expect(list.find((p) => p.id === located)).toMatchObject({
      latitude: 40.68921,
      longitude: -73.94421,
      takenAt: new Date("2026-09-24T14:15:00Z"),
    });
    expect(list.find((p) => p.id === plain)).toMatchObject({
      latitude: null,
      longitude: null,
    });
    await expect(up({ latitude: 91, longitude: 0 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("coordinates are for the project team only", async () => {
    const owner = await createUser("owner");
    const outsider = await createUser("external");
    const c = await callerFor(owner.id);
    const { id: projectId } = await createProject(
      owner.id,
      `M12 coords ${Date.now()}`,
    );
    await addMember(projectId, outsider.id);
    const photos = await db()
      .select({ id: schema.folder.id })
      .from(schema.folder)
      .where(eq(schema.folder.projectId, projectId));
    // Share every folder (including Photos) with the outsider so they can see site photos.
    for (const f of photos)
      await db()
        .insert(schema.folderShare)
        .values({ folderId: f.id, userId: outsider.id })
        .onConflictDoNothing();
    const b = await c.photos.beginUpload({
      projectId,
      contentType: "image/jpeg",
      fullBytes: 20,
      thumbBytes: 5,
      width: 4,
      height: 3,
      location: { latitude: 40.7, longitude: -73.9 },
    });
    for (const o of b.objects)
      await storage().put(
        o.pathname,
        new Uint8Array(o.role === "full" ? 20 : 5),
        { contentType: "image/jpeg" },
      );
    const { id } = await c.photos.completeUpload({
      projectId,
      uploadId: b.uploadId,
    });
    expect(
      (await c.photos.list({ projectId })).find((p) => p.id === id),
    ).toMatchObject({ latitude: 40.7, longitude: -73.9 });
    const seen = (
      await (await callerFor(outsider.id)).photos.list({ projectId })
    ).find((p) => p.id === id);
    expect(seen).toBeDefined();
    expect(seen).toMatchObject({ latitude: null, longitude: null });
  });
});

describe("Milestone 12: offline comments", () => {
  it("a comment sent twice with the same id is saved once", async () => {
    const owner = await createUser("owner");
    const c = await callerFor(owner.id);
    const { id: projectId } = await createProject(
      owner.id,
      `M12 comments ${Date.now()}`,
    );
    const [t] = await db()
      .insert(schema.task)
      .values({
        projectId,
        phaseKey: "acquisition",
        title: "Offline comment task",
      })
      .returning();
    const clientId = "0f0e0d0c-1111-4222-8333-444455556666";
    const a = await c.tasks.addComment({
      projectId,
      taskId: t!.id,
      body: "From the site",
      clientId,
    });
    const b = await c.tasks.addComment({
      projectId,
      taskId: t!.id,
      body: "From the site",
      clientId,
    });
    const both = await Promise.all([
      c.tasks.addComment({
        projectId,
        taskId: t!.id,
        body: "Twice at once",
        clientId: "aaaaaaaa-2222",
      }),
      c.tasks.addComment({
        projectId,
        taskId: t!.id,
        body: "Twice at once",
        clientId: "aaaaaaaa-2222",
      }),
    ]);
    expect(b.id).toBe(a.id);
    expect(both[0].id).toBe(both[1].id);
    const detail = await c.tasks.detail({ projectId, taskId: t!.id });
    expect(detail.comments.map((x) => x.body)).toEqual([
      "From the site",
      "Twice at once",
    ]);
    await expect(
      c.tasks.addComment({
        projectId,
        taskId: t!.id,
        body: "x",
        clientId: "bad id!",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
