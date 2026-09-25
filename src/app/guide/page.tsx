import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Team guide" };

/**
 * The one-page team guide (brief §15, Milestone 13). Public, like /install, so
 * it can be shared before someone has signed in. Kept in step with
 * docs/TEAM-GUIDE.md.
 */
const SECTIONS: { title: string; body: ReactNode }[] = [
  {
    title: "Get in",
    body: (
      <ul>
        <li>
          <b>Sign in</b> with your email or your sign-in name (for example <i>ariel</i>) and the password you were given. The first time, you choose your own password (10 or more characters).
        </li>
        <li>
          <b>Put it on your iPhone:</b> open the link in Safari, tap Share, then <b>Add to Home Screen</b>. <Link href="/install">Step-by-step pictures</Link>.
        </li>
        <li>
          <b>Face ID:</b> Settings → Face ID &amp; passkeys → Add. After that, Face ID signs you in.
        </li>
        <li>
          <b>Notifications:</b> allow them when asked (on iPhone, after adding the app to your Home Screen). Quiet hours and what you hear about are in Settings → Notifications.
        </li>
      </ul>
    ),
  },
  {
    title: "Your day: My Tasks",
    body: (
      <>
        <p>Everything you have to do, in order: Overdue, Today, This week, Later, Waiting on others, Awaiting my approval.</p>
        <ul>
          <li>
            <b>Tick</b> a task to finish it. Tap it to comment, @mention someone, attach a file or photo, or mark it waiting on a third party.
          </li>
          <li>A task that needs approval goes to the approver when you tick it, and is done once they approve.</li>
          <li>Blocked tasks show what they are waiting for.</li>
        </ul>
      </>
    ),
  },
  {
    title: "Projects",
    body: (
      <>
        <p>
          <b>Portfolio</b> shows every project you are on: its phase, progress, what is next and what is stuck, with a Needs you list at the top. A project has Overview, Checklist, Team, Dates &amp; Expiries, Files, Construction, Units, Public Records and Activity, and Financials only if you have been given access.
        </p>
        <ul>
          <li>
            <b>Construction:</b> daily log, schedule, RFIs, submittals, drawings, meetings and punch lists.
          </li>
          <li>
            <b>Photos:</b> Take photo opens the camera. Photos are dated; Add location is optional.
          </li>
        </ul>
      </>
    ),
  },
  {
    title: "Find anything",
    body: (
      <p>
        Press <kbd>⌘K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd> on Windows, or <kbd>/</kbd>), or use the Search tab on the iPhone. Type part of a project name, an address, a BBL, a task, a file or a person.
      </p>
    ),
  },
  {
    title: "On site with no signal",
    body: (
      <p>
        Screens you have opened stay readable. Ticks and comments made offline stay on your phone and are sent when you are back online; if someone changed that task in the meantime, the app asks you first. On a shared phone, <b>sign out</b>: it removes everything of yours.
      </p>
    ),
  },
  {
    title: "Who sees what",
    body: (
      <ul>
        <li>
          <b>Money</b> (budgets, invoices, the Financial folder) only if the owner turned on Financials for you on that project.
        </li>
        <li>
          <b>Outside collaborators</b> (architects, GCs, consultants) see only their own tasks and the folders shared with them.
        </li>
        <li>
          <b>Investors and lenders</b> see only their portal.
        </li>
        <li>Every change is recorded in the audit log.</li>
      </ul>
    ),
  },
  {
    title: "Sharing",
    body: <p>Tasks and alerts have a WhatsApp button that shares a link, never dollar figures. Email is off for now: invitations are links the owner sends you.</p>,
  },
  {
    title: "For the owner",
    body: (
      <ul>
        <li>
          <b>Weekly report:</b> every Monday at 7am New York time, one page per project. Open it from the menu or download the PDF.
        </li>
        <li>
          <b>Team:</b> invite people, set roles and per-project access (Financials, checklist edits, approvals), deactivate. Sign-in names for people without email: GitHub, Actions, Create account.
        </li>
        <li>
          <b>Audit log</b> and <b>System</b>: usage against the free limits, backups and job runs.
        </li>
      </ul>
    ),
  },
];

export default function TeamGuide() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 sm:px-8">
      <p className="eyebrow mb-3">Team guide</p>
      <h1 className="serif text-title sm:text-display">How to use Project Command</h1>
      <p className="mt-4 text-[15px] text-muted">One page. Five minutes. Everything you need day to day.</p>
      <ol className="mt-12 flex flex-col gap-10">
        {SECTIONS.map((s, i) => (
          <li key={s.title} className="grid grid-cols-[40px_1fr] gap-4">
            <span className="serif num flex size-10 items-center justify-center rounded-full border border-border bg-surface text-[18px]">{i + 1}</span>
            <section className="guide min-w-0 text-[15px] leading-relaxed [&_a]:underline [&_a]:underline-offset-4 [&_kbd]:rounded-control [&_kbd]:border [&_kbd]:border-border-strong [&_kbd]:px-1.5 [&_kbd]:font-mono [&_kbd]:text-[12px] [&_li]:mt-2 [&_p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
              <h2 className="text-[17px] font-medium">{s.title}</h2>
              {s.body}
            </section>
          </li>
        ))}
      </ol>
      <p className="mt-16 rounded-card border border-border bg-surface px-5 py-5 text-[15px]">
        <b>Something wrong?</b> Close the app and open it again, or sign out and back in. Still stuck? Tell Jon, with a screenshot.
      </p>
      <p className="mt-8 text-[15px]">
        <Link href="/" className="underline underline-offset-4">
          Open Project Command
        </Link>
      </p>
    </main>
  );
}
