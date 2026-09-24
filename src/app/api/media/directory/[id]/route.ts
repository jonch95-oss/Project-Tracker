import { eq } from "drizzle-orm";
import { DOWNLOAD_URL_TTL_MS } from "@/core/files";
import { canGlobal } from "@/core/permissions";
import { schema } from "@/server/db";
import { authedContextFrom } from "@/server/request-context";
import { bumpCounter } from "@/server/services/usage";
import { storage } from "@/server/storage";

/**
 * Opens a directory document's file (a license, COI or W-9). Staff who can
 * see the directory may open licenses and COIs; W-9s, which carry a tax ID,
 * only owners and admins. Checked on every request, then served from a
 * short-lived signed link (or streamed in local development).
 */
export async function GET(req: Request, ctx: RouteContext<"/api/media/directory/[id]">) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const c = await authedContextFrom(req);
  if (!c) return new Response("Sign in again", { status: 401 });
  if (!canGlobal(c.actor, "directory.view")) return new Response("Not found", { status: 404 });
  const [d] = await c.db.select().from(schema.vendorDocument).where(eq(schema.vendorDocument.id, id));
  if (!d?.objectKey) return new Response("Not found", { status: 404 });
  if (d.kind === "w9" && !canGlobal(c.actor, "directory.edit")) return new Response("Not found", { status: 404 });
  await bumpCounter("blob.transfer", d.sizeBytes ?? 0);
  const signed = await storage()
    .signedGetUrl(d.objectKey, DOWNLOAD_URL_TTL_MS)
    .catch(() => null);
  if (signed) return new Response(null, { status: 302, headers: { Location: signed, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  const obj = await storage().get(d.objectKey);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "Content-Type": d.contentType ?? obj.contentType,
      "Content-Length": String(obj.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(d.originalName ?? "document")}`,
    },
  });
}
