import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { authedContextFrom } from "@/server/request-context";
import { openUpload } from "@/server/services/uploads";
import { storage } from "@/server/storage";

/**
 * Local development and tests only: stands in for Vercel Blob's direct upload
 * when files live in the in-memory store. Same checks: signed in, an open
 * upload of this user's, one of its pathnames, within its size and type.
 */
export async function PUT(request: Request): Promise<NextResponse> {
  if (storage().name !== "memory" || process.env.VERCEL_ENV === "production") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ctx = await authedContextFrom(request);
  if (!ctx) return NextResponse.json({ error: "Sign in again" }, { status: 401 });
  const url = new URL(request.url);
  const row = await openUpload(db(), url.searchParams.get("upload") ?? "", ctx.viewer.id);
  const obj = row?.objects.find((o) => o.pathname === url.searchParams.get("path"));
  if (!row || !obj) return NextResponse.json({ error: "This upload isn't authorized or has expired." }, { status: 403 });
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (type !== obj.contentType || bytes.byteLength > obj.maxBytes) return NextResponse.json({ error: "Wrong size or type" }, { status: 400 });
  await storage().put(obj.pathname, bytes, { contentType: type });
  return NextResponse.json({ pathname: obj.pathname });
}
