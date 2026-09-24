/**
 * Milestone 12 (brief §12): camera photos keep when and, if the person chose,
 * where they were taken.
 */
import { describe, expect, it } from "vitest";
import { storage } from "@/server/storage";
import { callerFor, createProject, createUser } from "../support/fixtures";

describe("Milestone 12: photo capture", () => {
  it("saves the capture time and an optional location; bad coordinates are refused", async () => {
    const owner = await createUser("owner");
    const c = await callerFor(owner.id);
    const { id: projectId } = await createProject(owner.id, `M12 ${Date.now()}`);
    const up = async (location?: { latitude: number; longitude: number; accuracyM?: number | null } | null) => {
      const b = await c.photos.beginUpload({ projectId, contentType: "image/jpeg", fullBytes: 20, thumbBytes: 5, width: 4, height: 3, takenAt: new Date("2026-09-24T14:15:00Z"), location });
      for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(o.role === "full" ? 20 : 5), { contentType: "image/jpeg" });
      return (await c.photos.completeUpload({ projectId, uploadId: b.uploadId })).id;
    };
    const located = await up({ latitude: 40.68921, longitude: -73.94421, accuracyM: 12.4 });
    const plain = await up(null);
    const list = await c.photos.list({ projectId });
    expect(list.find((p) => p.id === located)).toMatchObject({ latitude: 40.68921, longitude: -73.94421, takenAt: new Date("2026-09-24T14:15:00Z") });
    expect(list.find((p) => p.id === plain)).toMatchObject({ latitude: null, longitude: null });
    await expect(up({ latitude: 91, longitude: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
