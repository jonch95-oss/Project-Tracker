import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Elevation } from "@/components/ui/architecture";

export const metadata: Metadata = { title: "Install on iPhone" };

/** Small drawings of what each step looks like on the phone (iOS's own screens can't be shown). */
const Frame = ({ children }: { children: ReactNode }) => <div className="mt-3 flex min-h-20 items-center justify-center rounded-panel border border-border bg-sunken px-4 py-4">{children}</div>;

const SafariBar = () => (
  <div className="flex w-full max-w-72 items-center gap-2 rounded-full bg-surface px-4 py-2 text-[13px] text-muted shadow-sm">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
    <span className="truncate">ariel-dev-projects.vercel.app</span>
  </div>
);

const ShareIcon = () => (
  <div className="flex w-full max-w-72 items-center justify-around rounded-panel bg-surface px-4 py-3 text-muted shadow-sm">
    <span aria-hidden="true">‹</span>
    <span aria-hidden="true">›</span>
    <span className="rounded-control bg-accent/15 p-1.5 text-accent">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-label="Share button">
        <path d="M12 3v12M8 7l4-4 4 4" />
        <path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
      </svg>
    </span>
    <span aria-hidden="true">□</span>
  </div>
);

const AddRow = () => (
  <div className="w-full max-w-72 overflow-hidden rounded-panel bg-surface text-[14px] shadow-sm">
    <div className="flex items-center justify-between px-4 py-2.5 text-muted">
      Add to Favorites <span aria-hidden="true">☆</span>
    </div>
    <div className="flex items-center justify-between border-t border-border bg-accent/10 px-4 py-2.5 font-medium">
      Add to Home Screen
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <path d="M12 8v8M8 12h8" />
      </svg>
    </div>
  </div>
);

const HomeIcon = () => (
  <div className="flex flex-col items-center gap-1.5">
    <Image unoptimized src="/apple-icon.png" alt="The Project Command icon" width={60} height={60} className="rounded-[14px] shadow-sm" />
    <span className="text-[12px]">Command</span>
  </div>
);

const AllowAlert = () => (
  <div className="w-full max-w-64 overflow-hidden rounded-panel bg-surface text-center text-[13px] shadow-sm">
    <p className="px-4 pt-3 font-medium">“Command” Would Like to Send You Notifications</p>
    <div className="mt-3 grid grid-cols-2 border-t border-border">
      <span className="py-2 text-muted">Don&apos;t Allow</span>
      <span className="border-l border-border bg-accent/10 py-2 font-medium">Allow</span>
    </div>
  </div>
);

const FaceId = () => (
  <div className="flex items-center gap-3 text-[14px]">
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-accent" aria-hidden="true">
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9v1.5M15 9v1.5M12 9v4.5h-1M9.5 16a4 4 0 0 0 5 0" />
    </svg>
    <span className="rounded-control border border-border bg-surface px-3 py-2 font-medium">Add a passkey on this device</span>
  </div>
);

const STEPS: { title: string; body: string; visual: ReactNode }[] = [
  { title: "Open in Safari", body: "Open your invitation link or the Project Command address in Safari. Other iPhone browsers can't install web apps with notifications.", visual: <SafariBar /> },
  { title: "Tap Share", body: "Tap the Share button (the square with an arrow pointing up) at the bottom of Safari. On some iPhones it's at the top right.", visual: <ShareIcon /> },
  { title: "Add to Home Screen", body: "Scroll down the list and tap “Add to Home Screen”, then tap Add. Keep the name “Command”.", visual: <AddRow /> },
  { title: "Open it from the Home Screen", body: "Launch Project Command from the new icon. It opens full screen, without Safari's address bar. Sign in there.", visual: <HomeIcon /> },
  { title: "Allow notifications", body: "Tap “Turn on” in the app, then Allow, so you hear about assignments, approvals and reminders. iPhone only allows this in apps opened from the Home Screen.", visual: <AllowAlert /> },
  { title: "Turn on Face ID", body: "In Settings → Face ID & passkeys, tap “Add a passkey on this device”. From then on you sign in with a glance.", visual: <FaceId /> },
];

const SHOTS = [
  { src: "/install/my-tasks.jpg", caption: "My Tasks: everything you need to do, in order. Tap the circle to check one off." },
  { src: "/install/checklist.jpg", caption: "Each project's phases and checklist." },
  { src: "/install/photos.jpg", caption: "Take photo: straight from the camera into the project, date-stamped, with your location if you want it." },
];

/** Public one-page guide, linked from every invitation and from Settings. */
export default function InstallGuide() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 sm:px-8">
      <Elevation className="mb-8 h-20 text-accent/60" />
      <p className="eyebrow mb-3">iPhone</p>
      <h1 className="serif text-title sm:text-display">Install Project Command</h1>
      <p className="mt-4 text-[15px] text-muted">It takes about a minute. There is no App Store download, and nothing to pay.</p>
      <ol className="mt-12 flex flex-col gap-10">
        {STEPS.map((s, i) => (
          <li key={s.title} className="grid grid-cols-[48px_1fr] gap-4">
            <span className="serif num flex size-12 items-center justify-center rounded-full border border-border bg-surface text-[22px]">{i + 1}</span>
            <div className="min-w-0">
              <h2 className="text-[17px] font-medium">{s.title}</h2>
              <p className="mt-1 text-[15px] text-muted">{s.body}</p>
              <Frame>{s.visual}</Frame>
            </div>
          </li>
        ))}
      </ol>

      <section aria-labelledby="see-h" className="mt-16">
        <h2 id="see-h" className="serif text-heading">
          What you&apos;ll see
        </h2>
        <ul className="-mx-4 mt-6 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-6 sm:overflow-visible sm:px-0">
          {SHOTS.map((s) => (
            <li key={s.src} className="w-[68%] shrink-0 snap-start sm:w-auto">
              <Image unoptimized src={s.src} alt="" width={390} height={844} className="w-full rounded-card border border-border" />
              <p className="mt-2 text-[13px] text-muted">{s.caption}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="offline-h" className="mt-16 rounded-card border border-border bg-surface px-5 py-5">
        <h2 id="offline-h" className="text-[17px] font-medium">
          On site with no signal
        </h2>
        <p className="mt-2 text-[15px] text-muted">
          Pages you&apos;ve opened before, like My Tasks and your projects, still open. Check-offs and comments are saved on your phone and sent as soon as you&apos;re back online. If someone changed the same task in the meantime, the app asks before applying yours. Signing out clears everything saved on the phone.
        </p>
      </section>

      <Link href="/login" className="mt-12 inline-flex h-12 items-center rounded-control bg-primary px-6 text-[15px] font-medium text-on-primary">
        Go to sign in
      </Link>
    </main>
  );
}
