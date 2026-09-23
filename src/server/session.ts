import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "./auth";
import { loadViewer, type Viewer } from "./trpc/init";

/** The signed-in, active viewer for this request (deduplicated per render). */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  // Read request headers before touching env/auth: this marks the route as
  // dynamic, so the build never tries to prerender signed-in pages.
  const requestHeaders = await headers();
  const session = await auth().api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const viewer = await loadViewer(session.user.id);
  if (!viewer || viewer.status !== "active") return null;
  return viewer;
});

export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  return viewer;
}

export async function requireOwner(): Promise<Viewer> {
  const viewer = await requireViewer();
  if (viewer.role !== "owner") redirect("/");
  return viewer;
}
