import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { databaseConfigured, getViewer } from "@/server/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getViewer()) redirect("/");
  if (!databaseConfigured()) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="serif text-[40px] leading-[44px]">Almost ready</h1>
        <p className="text-[15px] text-muted">
          Project Command is deployed, but its database isn&apos;t connected yet. Sign-in opens as soon as the owner connects it.
        </p>
      </div>
    );
  }
  return <LoginForm />;
}
