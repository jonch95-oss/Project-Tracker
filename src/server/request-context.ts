import "server-only";
import { auth } from "./auth";
import { db } from "./db";
import { clientIp } from "./request-ip";
import { loadViewer, type AuthedContext } from "./trpc/init";

/** The signed-in, active viewer for a plain route handler (not tRPC), or null. */
export async function authedContextFrom(req: Request): Promise<AuthedContext | null> {
  const session = await auth().api.getSession({ headers: req.headers });
  if (!session) return null;
  const viewer = await loadViewer(session.user.id);
  if (!viewer || viewer.status !== "active") return null;
  return {
    db: db(),
    headers: req.headers,
    ip: clientIp(req.headers),
    viewer,
    actor: { userId: viewer.id, role: viewer.role, status: viewer.status },
  };
}
