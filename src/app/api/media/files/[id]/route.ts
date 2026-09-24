import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { DOWNLOAD_URL_TTL_MS, previewKind } from "@/core/files";
import { schema } from "@/server/db";
import { authedContextFrom } from "@/server/request-context";
import { bumpCounter } from "@/server/services/usage";
import { storage } from "@/server/storage";
import { createCaller } from "@/server/trpc/root";

/**
 * Opens one version of a file (`/api/media/files/{versionId}`), or its image
 * thumbnail (`?thumb=1`). Access is checked on every request exactly as the
 * Files tab checks it (folder, task attachment, gated Financial folder). The
 * bytes then come from a 5-minute signed storage link, so large files never
 * pass through our servers; without signing (local development) they stream.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/media/files/[id]">) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const c = await authedContextFrom(req);
  if (!c) return new Response("Sign in again", { status: 401 });
  const [v] = await c.db
    .select({ v: schema.fileVersion, projectId: schema.file.projectId })
    .from(schema.fileVersion)
    .innerJoin(schema.file, eq(schema.file.id, schema.fileVersion.fileId))
    .where(and(eq(schema.fileVersion.id, id)));
  if (!v) return new Response("Not found", { status: 404 });
  try {
    // The same visibility rules as the Files tab: if the files router refuses, so do we.
    await createCaller(c).files.canRead({ projectId: v.projectId, fileId: v.v.fileId });
  } catch (e) {
    if (e instanceof TRPCError) return new Response("Not found", { status: 404 });
    throw e;
  }
  const thumb = new URL(req.url).searchParams.get("thumb") === "1";
  const key = thumb ? v.v.thumbKey : v.v.objectKey;
  if (!key) return new Response("Not found", { status: 404 });
  const size = thumb ? v.v.thumbBytes : v.v.sizeBytes;
  await bumpCounter("blob.transfer", size);
  const signed = await storage()
    .signedGetUrl(key, DOWNLOAD_URL_TTL_MS)
    .catch(() => null); // signing trouble: fall back to streaming it ourselves
  if (signed) {
    // The browser may reuse this redirect for 4 minutes (the link lives 5), so a folder of thumbnails isn't re-signed on every view.
    return new Response(null, { status: 302, headers: { Location: signed, "Cache-Control": "private, max-age=240", "Referrer-Policy": "no-referrer" } });
  }
  const obj = await storage().get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const inline = thumb || previewKind(v.v.contentType) !== "none";
  return new Response(obj.body, {
    headers: {
      "Content-Type": thumb ? obj.contentType : v.v.contentType,
      "Content-Length": String(obj.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(v.v.originalName)}`,
    },
  });
}
