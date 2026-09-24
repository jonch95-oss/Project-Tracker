import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { authedContextFrom } from "@/server/request-context";
import { openUpload } from "@/server/services/uploads";
import { storage } from "@/server/storage";

/**
 * Issues Vercel Blob client-upload tokens. The browser asks for a token for
 * one pathname; we only grant it when that exact pathname belongs to an
 * upload this user was authorized for (see photos.beginUpload), and the token
 * is limited to that object's size and type. No completion webhook: the
 * client calls completeUpload, which checks the stored object itself.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (storage().name !== "vercel-blob") return NextResponse.json({ error: "Direct uploads are not configured" }, { status: 404 });
  const ctx = await authedContextFrom(request);
  if (!ctx) return NextResponse.json({ error: "Sign in again" }, { status: 401 });
  const body = (await request.json()) as HandleUploadBody;
  if (body.type !== "blob.generate-client-token") return NextResponse.json({ error: "Unsupported" }, { status: 400 });
  try {
    const json = await handleUpload({
      body,
      request,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const row = clientPayload ? await openUpload(db(), clientPayload, ctx.viewer.id) : null;
        const obj = row?.objects.find((o) => o.pathname === pathname);
        if (!row || !obj) throw new Error("Upload not authorized");
        return {
          allowedContentTypes: [obj.contentType],
          maximumSizeInBytes: obj.maxBytes,
          addRandomSuffix: false,
          allowOverwrite: false,
          validUntil: row.expiresAt.getTime(),
        };
      },
    });
    return NextResponse.json(json);
  } catch {
    return NextResponse.json({ error: "This upload isn't authorized or has expired." }, { status: 403 });
  }
}
