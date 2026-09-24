import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewer } from "@/server/session";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Choose your password" };

/** First sign-in with a temporary password: the person chooses their own before anything else opens. */
export default async function ChangePasswordPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (!viewer.mustChangePassword) redirect("/");
  return <ChangePasswordForm name={viewer.name} />;
}
