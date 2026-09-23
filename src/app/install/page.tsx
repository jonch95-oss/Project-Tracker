import type { Metadata } from "next";
import Link from "next/link";
import { Elevation } from "@/components/ui/architecture";

export const metadata: Metadata = { title: "Install on iPhone" };

const STEPS = [
  { title: "Open in Safari", body: "Open your invitation link or the Project Command address in Safari. Other iPhone browsers can't install web apps with notifications." },
  { title: "Tap Share", body: "Tap the Share button (the square with an arrow pointing up) in Safari's toolbar." },
  { title: "Add to Home Screen", body: "Scroll down and tap “Add to Home Screen”, then tap Add. Project Command appears with its own icon." },
  { title: "Open it from the Home Screen", body: "Launch Project Command from the new icon. It opens full screen, without Safari's address bar." },
  { title: "Allow notifications", body: "When asked, tap Allow so you receive assignments, approvals and reminders. iPhone only allows this for apps opened from the Home Screen." },
  { title: "Turn on Face ID", body: "In Settings → Face ID & passkeys, tap “Add a passkey on this device”. From then on you sign in with a glance." },
];

/** Public one-page guide, linked from every invitation email. */
export default function InstallGuide() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 sm:px-8">
      <Elevation className="mb-8 h-20 text-accent/60" />
      <p className="eyebrow mb-3">iPhone</p>
      <h1 className="serif text-title sm:text-display">Install Project Command</h1>
      <p className="mt-4 text-[15px] text-muted">It takes about a minute. There is no App Store download.</p>
      <ol className="mt-12 flex flex-col gap-8">
        {STEPS.map((s, i) => (
          <li key={s.title} className="grid grid-cols-[48px_1fr] gap-4">
            <span className="serif num flex size-12 items-center justify-center rounded-full border border-border bg-surface text-[22px]">{i + 1}</span>
            <div>
              <h2 className="text-[17px] font-medium">{s.title}</h2>
              <p className="mt-1 text-[15px] text-muted">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <Link href="/login" className="mt-12 inline-flex h-12 items-center rounded-control bg-primary px-6 text-[15px] font-medium text-on-primary">
        Go to sign in
      </Link>
    </main>
  );
}
