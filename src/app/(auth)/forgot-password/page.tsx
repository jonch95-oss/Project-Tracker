import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { emailEnabled } from "@/server/services/email";
import { ForgotForm } from "./forgot-form";

export const metadata: Metadata = { title: "Reset password" };

export default async function ForgotPasswordPage() {
  await headers();
  if (emailEnabled()) return <ForgotForm />;
  // Email is on hold: the owner issues reset links from Team instead.
  return (
    <div className="flex flex-col gap-6">
      <h1 className="serif text-title">Reset password</h1>
      <p className="text-[15px] text-muted">
        Ask the owner for a reset link. They can create one for you from the Team page and send it by WhatsApp or text. It works once, for one hour.
      </p>
      <Link href="/login" className="text-sm text-muted underline underline-offset-4 hover:text-text">
        Back to sign in
      </Link>
    </div>
  );
}
