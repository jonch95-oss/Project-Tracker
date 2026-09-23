import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { databaseConfigured } from "@/server/session";
import { hasAnyUser } from "@/server/services/setup";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up" };

/** One-time owner setup. Disappears (redirects to sign-in) once any user exists. */
export default async function SetupPage() {
  await headers();
  if (!databaseConfigured()) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="serif text-[40px] leading-[44px]">Connect the database first</h1>
        <p className="text-[15px] text-muted">Connect the Neon database to this Vercel project, redeploy, then return here.</p>
      </div>
    );
  }
  if (await hasAnyUser()) redirect("/login");
  return <SetupForm />;
}
