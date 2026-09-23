import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { TRPCReactProvider } from "@/lib/trpc";
import { createContext } from "@/server/trpc/init";
import { createCaller } from "@/server/trpc/root";
import { AcceptInviteForm } from "./accept-form";

export const metadata: Metadata = { title: "Accept invitation" };

const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Team member", external: "Outside collaborator" } as const;

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const caller = createCaller(await createContext({ headers: await headers() }));
  const invite = token.length >= 20 && token.length <= 100 ? await caller.invites.lookup({ token }) : { state: "invalid" as const };

  if (invite.state !== "valid") {
    const copy = {
      invalid: ["This invitation isn't valid", "The link may have been replaced by a newer invitation. Ask the person who invited you to send it again."],
      expired: ["This invitation has expired", "Invitations last 7 days. Ask the person who invited you to send a new one."],
      accepted: ["Already accepted", "This invitation has been used. Sign in with your email and password."],
    }[invite.state];
    return (
      <div className="flex flex-col gap-6">
        <h1 className="serif text-[40px] leading-[44px]">{copy[0]}</h1>
        <p className="text-[15px] text-muted">{copy[1]}</p>
        <Link href="/login" className="text-sm underline underline-offset-4">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <TRPCReactProvider>
      <AcceptInviteForm token={token} email={invite.email} defaultName={invite.name} roleLabel={ROLE_LABEL[invite.role]} />
    </TRPCReactProvider>
  );
}
