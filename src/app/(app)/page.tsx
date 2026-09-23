import { redirect } from "next/navigation";
import { requireViewer } from "@/server/session";

/** Owners and admins start on Portfolio; everyone else on My Tasks. */
export default async function Home() {
  const viewer = await requireViewer();
  redirect(viewer.role === "owner" || viewer.role === "admin" ? "/portfolio" : "/tasks");
}
