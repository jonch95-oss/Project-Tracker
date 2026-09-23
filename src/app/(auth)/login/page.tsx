import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { databaseConfigured, getViewer } from "@/server/session";
import { safeNextPath } from "@/core/redirect";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = safeNextPath(typeof sp.next === "string" ? sp.next : null);
  if (await getViewer()) redirect(next);
  if (!databaseConfigured()) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="serif text-title">Almost ready</h1>
        <p className="text-[15px] text-muted">
          Project Command is deployed, but its database isn&apos;t connected yet. Sign-in opens as soon as the owner connects it.
        </p>
      </div>
    );
  }
  return <LoginForm next={next} justReset={sp.reset === "1"} />;
}
