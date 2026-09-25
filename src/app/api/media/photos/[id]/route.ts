import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { schema } from "@/server/db";
import { authedContextFrom } from "@/server/request-context";
import { canSeePhotos } from "@/server/services/files";
import { bumpCounter } from "@/server/services/usage";
import { storage } from "@/server/storage";
import { projectAccess } from "@/server/trpc/init";

/**
 * Serves a project photo to someone who can see the project. Files are private
 * in Blob; this route is the only way to read them, and it checks access on
 * every request. The browser keeps a private copy for 10 minutes (photos
 * never change under the same id), which keeps Blob downloads down while
 * still ending access soon after someone is removed from the project.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/media/photos/[id]">) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const c = await authedContextFrom(req);
  if (!c) return new Response("Sign in again", { status: 401 });
  const [photo] = await c.db.select().from(schema.projectPhoto).where(eq(schema.projectPhoto.id, id));
  if (!photo) return new Response("Not found", { status: 404 });
  try {
    const access = await projectAccess(c, photo.projectId);
    if (!(await canSeePhotos(c.db, access, c.viewer.id))) return new Response("Not found", { status: 404 });
  } catch (e) {
    if (e instanceof TRPCError) return new Response("Not found", { status: 404 });
    throw e;
  }
  const size = new URL(req.url).searchParams.get("size") === "full" ? "full" : "thumb";
  const key = size === "full" ? photo.objectKey : photo.thumbKey;
  const obj = await storage().get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  await bumpCounter("blob.transfer", obj.size);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.contentType,
      "Content-Length": String(obj.size),
      "Cache-Control": "private, max-age=600",
      // Kept per sign-in: after a sign-out (a new session cookie) the browser asks again.
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
