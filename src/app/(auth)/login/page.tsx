import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewer } from "@/server/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getViewer()) redirect("/");
  return <LoginForm />;
}
