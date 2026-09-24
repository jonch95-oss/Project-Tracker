# Progress

## Changes asked for after Milestone 12 (24 Sep)

- **Sign-in by username:**
  - People can sign in with a username (e.g. `ariel`) as well as an email.
  - Accounts can be made with a temporary password through the **Create account** GitHub workflow (Actions → Create account → Run workflow).
  - Someone with a temporary password must choose their own before anything else opens. The app, the API and file links are all closed until they do.
  - Password minimum is now 10 characters (Jon's call).
- **Admins see every project:** admins now see and run every project and can assign tasks on all of them, including ones they haven't been added to. Money still follows each project's Financials switch, and the permission matrix covers the unassigned-admin case.
- **Not done: an "invisible owner".** Jon asked for an owner who has full power but whose actions nobody else can see (shown as "Project Command", left out of people lists). This session's safety check blocked the change as audit/logging tampering, so it was left for Jon to decide.

## Milestone 12 — iPhone home-screen app (built; real-iPhone check pending)

**Live:** https://ariel-dev-projects.vercel.app (install it from Safari: Share → Add to Home Screen; the guide is at /install)

### What shipped

- **Camera capture (brief §12).**
  - **Where:** "Take photo" opens the camera straight into project photos, task attachments, the daily site log and punch items.
  - **On the phone:** each photo is compressed (long edge 2560px) and stamped with the date and time in New York.
  - **Location:** optional, one switch per phone ("Add location") next to every camera button. The coordinates are saved with the photo, not printed on it. Only the project team sees them; outside collaborators and investors don't.
  - **Library photos:** a photo picked from the library instead (or on a computer) keeps its own EXIF time and is never stamped or located as if it were taken just now.
- **Offline reading.**
  - **What's kept:** the screens a person has opened (My Tasks, projects, checklists, tasks, photos, the field modules) are saved on the phone under their own user id and shown when the app starts with no connection.
  - **What's never kept:** money, capital, audit and admin screens.
  - **Pages:** the service worker saves the app's page shells and script files so the app can start offline. It never shows a saved copy while there's a connection.
  - **Cleared:** everything saved is deleted on sign-out, and anything left by a previous person is wiped as soon as someone else signs in on the same phone.
- **Offline check-offs and comments.**
  - **Straight away:** ticking a task or posting a comment with no signal saves it on the phone and shows it at once, including after the app is closed.
  - **Syncing:** it's sent when the connection comes back, the app returns to the foreground, or every 30 seconds, one sync at a time across open tabs.
  - **Conflicts:** a tick on a task someone changed in the meantime is held as a conflict ("Tick it anyway" or Discard). A tick that needs a file first is held with that reason.
  - **Temporary errors:** a waking server or an ended session keeps the change queued; nothing is dropped silently.
  - **No duplicates:** each comment carries its own id, so a resend can't post it twice.
- **Faster tabs.** Switching project and Construction tabs now changes only the address in the browser, with no server call, so tabs switch instantly and work offline.
- **Install guide (/install).** Each step has a picture, followed by three real screenshots and an "on site with no signal" note. It's linked on the invitation page and inside the WhatsApp invitation text. Face ID sign-in (passkeys) and push links that open the task were already in place.

### Review

The independent review found 1 P0, 5 P1 and 8 P2 issues. All are fixed. The offline design was reworked rather than patched.

The P0:

- **Saved data could survive a session that ended without a sign-out,** and could then be shown to the next person on the same phone. Now:
  - Saved data is kept per person, and wiped when someone else signs in.
  - The sign-in page clears saved pages.
  - Data is no longer cached in the service worker at all.

The P1s:

- **Stale copies while online:** a 4-second race could show a saved copy on a slow connection, and removed access didn't evict it. The network race is gone, and saved answers are always refetched when online.
- **Slower pages:** the worker held responses until they were fully saved, which stopped pages streaming in. Responses now go straight through, and saving happens in the background.
- **Refused ticks reported as synced:** a tick the server turned down was still reported as synced. It's now held with the reason.
- **Temporary errors lost changes:** a temporary error permanently failed a queued change, and a failed comment's text was lost. These stay queued now, with Retry and "Copy text".
- **Duplicate comments:** a second tab, or a resend after a dropped connection, could post a comment twice. There's now a cross-tab lock and a unique id per comment.

The P2s fixed:

- A held tick no longer shows as done.
- A conflict no longer turns into "task gone" when the phone is offline.
- One saved page per path (no stale partial payloads).
- Separate reads are batched again (fewer server calls).
- Caches are capped.
- Coordinates are hidden from outsiders and no longer printed on photos.
- Library photos aren't stamped as new.
- Photo file names use New York time.
- A test covers sign-out leaving nothing behind.

Also fixed along the way: CI had been failing since Milestone 10 because the new `src/core` modules had pulled unit-test coverage under the 95% bar. That's back over the line (98%) with new unit tests.

### Test results

- **Unit and integration:** 3,703 passing. New tests cover the offline queue (9), photo location and comment de-duplication, and every `src/core` module again above 95% coverage.
- **Browser (Playwright):** 48 passing against a production build. New tests:
  - camera photo
  - approve on iPhone
  - offline tick, reopen offline, then sync
  - offline comment plus a conflict resolved with "Tick it anyway"
  - sign-out leaves no pages, data or queue behind
- **CI:** the iPhone WebKit project now runs the offline tests as well. Each run creates its own task, so no test depends on shared demo data.
- **One step skipped on WebKit:** reopening a page offline. Playwright's WebKit can't load any page while it emulates offline, even from the service worker. Chromium covers that step, and the real iPhone check covers it on the phone.
- **Screens:** checked at 390px and desktop (install guide, the offline bar, Photos, task attachments).

### Real iPhone check (Jon, 24 Sep)

Home-screen install, notifications and tapping a notification to open the task, Face ID sign-in, camera photos, the offline tick and its sync all worked on Jon's iPhone.

One thing failed: opening the app from its icon in Airplane Mode showed "You're offline — this page hasn't been saved yet". Fixed:

- **The cause:** the icon opens "/", which the server redirects to each person's start page, and that address was never saved.
- **Opening from the icon:** the app now tells the service worker each person's start page (Portfolio, My Tasks or the portal), and "/" opens its saved copy when there's no connection.
- **Detecting offline:** the app no longer trusts the phone's online flag, which can stay "online" in Airplane Mode. A request that fails for lack of connection switches the app to offline, so reads pause and the saved copy stays on screen instead of "This didn't load". A small check every 10 seconds notices when the connection is back.
- **Saving:** what's on screen is also saved the moment the app goes to the background.

A new browser test covers opening from the icon with no signal.

### Known limitations

- **First visit only online:** a page opens offline only after it has been visited once online, since it's saved as it's used.
- **Tick results offline:** an offline tick on an approval task shows as sent for approval (or as done, for the approver); the server decides when it syncs.

## Milestone 11 — Calendar feed, email into a project, analytics, import (done)

**Live:** https://ariel-dev-projects.vercel.app (Settings → Calendar feed; Analytics and Import in the sidebar for the owner and admins; each project's Activity tab)

### What shipped

- **Calendar feed (Module H).**
  - **The link:** each person makes a private link in Settings. It works with iPhone and Mac Calendar (one tap, via webcal), Google Calendar and Outlook. It's shown once, only its hash is stored, and making a new one or turning it off kills the old link at once.
  - **What's in it:** your own open tasks everywhere. The internal team also gets inspections, key dates, closings, meetings and expiries on their projects. Outside collaborators get only their own RFIs, submittals and punch items.
  - **No money:** loan and 1031 dates and financial expiries appear only for people with financial access, and there are never amounts. Investors have no feed.
  - **Updates:** events are all-day dates with stable IDs, so a moved date updates in place. Settings shows when a calendar last read the feed.
- **Email into a project (Module I): built and tested, but not switched on.**
  - **How it works:** every project gets an address like `347-myrtle-k3f9@<inbound domain>`, shown on its Activity tab with a copy button. Owners and admins can replace it, and the old one stops working.
  - **Where mail lands:** a forwarded email is saved as a text file, and its attachments go into the project's "Inbox" folder to be filed. Activity says who sent what.
  - **Who can send:** only an active, registered member of the project's internal team, and only when the receiving mail server verified the From address (DMARC pass, or DKIM pass for the sender's domain). Everything else is recorded as refused and nothing is saved.
  - **Security:** webhooks must carry a valid, fresh Svix signature (Resend's scheme), and a redelivered message is saved once.
  - **Email budget:** accepted mail counts toward the 100-a-day quota. Refused mail shows in the budget on the System page, but it doesn't hold back outgoing mail, so a stranger can't use up the day.
  - **Why it's off:** email is on hold (Change Order 01), so there's no inbound provider or domain yet. It's off unless both `INBOUND_EMAIL_DOMAIN` and `INBOUND_EMAIL_SECRET` are set; until then the route answers 404 and the Activity tab says it isn't set up. *Closest safe choice:* the handler is complete and tested, but Resend's inbound payload couldn't be checked from here. If the webhook carries only metadata, the handler fetches the body and attachments by message ID with `RESEND_API_KEY`. **Before switching it on,** send one real test email and confirm the fields (body, attachments, Authentication-Results) arrive as expected.
- **Analytics (Module M), owner only.**
  - **Phases and costs:** median actual days per phase by project type, and cost per gross and sellable sf (forecast and actual, hard and total), with the median by type as a benchmark.
  - **Budgets and bottlenecks:** budget variance by category across the portfolio, and where tasks stall: overdue and waiting now, and how late finished work ran, by phase and by person.
  - **Turnaround:** RFI answer times and invoice approval times.
  - **Template durations from actuals:** where a template task has taken noticeably longer or shorter (at least 2 days and 20%) on 3 or more projects, it suggests the median. The chosen ones save as a new template version.
- **Import from Excel (Module N), owner and admins.**
  - **What it imports:** projects, budget lines, unit schedules, the vendor directory and checklist templates, from .xlsx or .csv.
  - **Before anything is saved:** columns are matched from the headers and can be changed. The preview counts rows read, valid and turned away, with the reason for each and its row number in the sheet.
  - **Saving:** rows go through the same procedures as the screens, so every permission, number and side effect applies. A template is all or nothing.
  - **Limits:** 4 MB, 500 rows, 50 projects at a time, and a cap on the unpacked size of .xlsx files. Rows that are already there (same project name and address, same budget line, same unit, same company) are skipped and listed.

### Review

The independent review found 4 P1 and 11 P2 issues. All are fixed, with regression tests.

The P1s were:

- **Refused inbound mail counted against outgoing mail.** Enough junk mail could have held back invites and password resets for the day. Now only accepted mail counts.
- **A forged From line was trusted.** The sender must now be verified by the receiving server, and the address can be replaced.
- **The webhook might carry only metadata.** The body and attachments are now fetched by message ID when they're missing.
- **Imports could repeat or time out.** Large project imports could time out halfway through, and a second click could import the same rows again. Projects are now capped at 50 per import, the file is cleared after importing, and existing rows are skipped.

The P2s fixed:

- **Email-in storage:** stored files are deleted if saving the email fails, and storage errors return a retry to the provider instead of silently dropping the mail.
- **Import errors:** internal error text never reaches the import report.
- **Templates:** a looping template is refused before anything is created, and a failed save doesn't leave a stray template.
- **Row counts and numbers:** true row counts for big sheets, and row numbers that match the spreadsheet.
- **Upload limits:** an unpacked-size check before opening an .xlsx, and a clear message for files over the platform's size limit.
- **Activity entries:** import entries go only to projects the person is on.
- **Calendar links:** only one link can be live per person, even with a double tap.
- **ICS text:** bare carriage returns and control characters are escaped.
- **Email-in notices:** a note that the whole project team sees emailed-in files, and a correct "not set up" message.

### Test results

- **Unit and integration:** 3,672 passing, including 19 new unit and 14 new integration tests. The permission matrix now has 3,126 checks, with rows for every new procedure.
- **Browser (Playwright):** 43 passing, 5 of them new.
- **Screens:** checked at desktop and iPhone widths (Analytics, Import, the Calendar feed and Activity).

### Known limitations

- **Email-in is off** until an inbound mail domain and a signing secret exist. Email is on hold and there is no inbound provider on a free tier yet.
- **Analytics are only as good as the dates recorded.** Phase durations need a start and a finish, and the duration suggestions need three finished projects from the same template.

## Milestone 10 — Directory, BBL auto-fill, investors and units (done)

**Live:** https://ariel-dev-projects.vercel.app (the Directory in the sidebar; each condo project's Units tab and Financials → Capital; investors sign in to their own portal)

### What shipped

- **BBL auto-fill (Module A).**
  - **Filling the form:** in New project and Edit project, a full BBL, or the address alone, fills the lot's facts from PLUTO (NYC Open Data 64uk-42ks): zoning with overlays and special districts, lot area, frontage and depth, residential FAR, built FAR, and unused ZSF ((residential FAR − built FAR) × lot area).
  - **What it won't touch:** only empty fields are filled; what someone typed is kept. The form says which release it used, or why it couldn't (no BBL for the address, wrong borough, not in PLUTO yet, city service down).
  - **Real data:** columns and value formats were checked against a live row pulled through the `Records probe` workflow. That row is now the test fixture.
  - **First records snapshot:** a project that gets a lot, on create or when its BBL changes, pulls its public-records snapshot right after the save is committed, instead of waiting for the nightly run.
  - **Kept separate:** the deal-origination platform is never touched.
- **Vendor and contact directory (Module C).**
  - **Each company has:** kind, trade, contact details, an internal 1–5 rating and notes, and the people who work there.
  - **Paperwork:** licenses (GC, DOB registration, master plumber and electrician), COIs (GL, workers' comp, disability) and W-9s, each with its number, expiry and the file itself (PDF or photo).
  - **Reminders:** licenses and COIs remind the owners at 30, 14 and 7 days, then daily once expired, and only the newest document of each kind counts.
  - **Lapsed COIs:** a lapsed directory COI flags the company on every live project it's on, the same way as the expiry tracker. A renewal clears the flag.
  - **Links to the work:** contracts and invoices typed under a company's name link to it automatically, including after a rename. Tasks can name the company doing them.
  - **Projects list:** each company page shows the projects it's on, and contract links only appear for people who can see financials.
  - **Outside collaborators:** invited straight from a contact, with a copy-or-WhatsApp link, since email is off.
  - **Access:** the internal team reads the directory; owners and admins keep it. W-9s carry a tax ID, so only owners and admins see them.
- **Investor / lender portal (Module J).**
  - **The role:** a new read-only "Investor" role. Investors land on their portal and can reach only it, the project's photos and the folders shared with them. A single allowlist on the server enforces this, whatever a screen asks for.
  - **Portal contents:** phase and progress, photos (shared automatically when they're added to a project), schedule status against the baseline, shared documents, and their own capital account if the financials flag is on for them. They never see anyone else's account.
  - **Capital (Financials → Capital):**
    - **Investors:** shared across projects, with a commitment on each.
    - **Calls:** split by commitment, with receipts recorded as money comes in.
    - **Distributions:** split by the waterfall as of the day paid, previewed before saving, and recorded in date order.
    - **Waterfall:** configurable tiers: a simple preferred return, return of capital, and LP/sponsor splits with optional multiple hurdles.
    - **Accounts:** each shows committed, called, contributed, distributed (capital, pref and profit), still invested, unfunded and pref owed.
  - **The math:** lives in `src/core/waterfall.ts` and is unit-tested. It runs in integer cents, and the parts always sum to the whole.
  - **Quarterly report PDF:** progress, the quarter's milestones and phases, schedule, capital activity and the waterfall. Investors get their own account only; financial staff get the whole table.
  - **Notices:** linked investors get in-app and push notices of calls and distributions.
- **Condo unit tracker (Module L).**
  - **Units tab:** each unit with floor, sf, beds and baths, exposure and outdoor space. Asking price, $/sf and sale status show only to people with financial access. These are the same rows as the sales tracker in Financials.
  - **Buyer selections:** upgrades and finish choices per unit, each with a sign-off deadline. Each one creates a GC task that waits on the buyer's sign-off, then goes live once it's recorded. Overdue sign-offs show in red.

### Review

The independent review found 4 P0, 4 P1, 6 P2 and 3 P3 issues. All are fixed, with regression tests.

The P0s were:

- **An investor record could be rewired from another project.** An admin with financial access on one project could change the name, email or portal login of an investor who was also on a project that admin couldn't see. Editing an investor now needs the owner, or financial edit rights on every project they're in. Adding an existing investor to a project only sets the commitment.
- **Investors could be given tasks,** which then showed up outside their portal. They're now left out of every assignee, watcher and @mention list, and their task lists are always empty.
- **Changing someone's role kept flags that mean different things.** For an investor, the financials flag means "my own account"; for a collaborator it means the whole Financials tab. Crossing into or out of the investor role now resets their project flags. Becoming an investor also releases their tasks and approvals, and leaving the role ends the portal link.
- **Receipts could be edited after a distribution was split using them.** They're now locked once a distribution relies on them, and the edit takes the same lock as distributions.

The P1s were:

- "Add an existing investor" always failed.
- Tasks linked to a company that was later archived couldn't be saved.
- Contract and invoice edits dropped their directory link.
- Distributions could be dated in the future.

The P2s and P3s fixed:

- **First records snapshot:** it's now queued only after the save commits, and the request route has an explicit time limit.
- **PLUTO fill:** a lot 1,000 ft or deeper no longer fails the form.
- **Reminders:** duplicate same-date documents remind once.
- **Unique names:** duplicate company or unit names arriving at the same moment get a clear message instead of a server error.
- **Selection tasks:** the "waiting since" date no longer resets on every save, reassignment notifies the new GC, and a signed-off task drops the buyer's deadline.
- **COI flags:** a flag that comes from contracts or invoices only shows to people with financial access.
- **Units:** sale status and upgrade flags are hidden without financial access.
- **Portal files:** no upload button for investors, and the Photos folder jumps to the photos.
- **PLUTO stub:** it can never run on the live site.

### Test results

- 3,499 unit and integration tests pass. New this milestone: `tests/unit/pluto.test.ts` (on the live PLUTO row), `tests/unit/waterfall.test.ts` (hand-checked scenarios) and `tests/integration/m10.test.ts` (18 tests).
- The permission matrix adds investor scenarios (with and without the capital flag, and unassigned). It re-checks every procedure for the new role and covers every new procedure: 3,000+ cases.
- 38 of 38 Playwright end-to-end tests pass. New in `tests/e2e/m10.spec.ts`:
  - PLUTO fills the new-project form
  - the directory flags a lapsed COI, adds a person and invites them
  - a unit selection is signed off
  - a capital receipt and a distribution run through the waterfall
  - the investor lands on the portal, sees only their own account, and is redirected away from the project page and Portfolio
- Checked visually at desktop and iPhone sizes: Directory, company page, Units, Capital, portal list and portal project. No console errors, no sideways scrolling.

### Known limitations

- PLUTO lags new condo lots by a release or two; the form says so when a lot isn't there yet.
- The waterfall's preferred return is simple interest (not compounding) on each investor's unreturned capital, actual/365. IRR-based hurdles aren't offered; hurdles are equity multiples.
- A W-9's file is stored in Blob like other uploads; only owners and admins can open it.

## Milestone 9 — Field and construction (done)

**Live:** https://ariel-dev-projects.vercel.app (each project's Construction tab: Daily log, Schedule, RFIs, Submittals, Drawings, Punch, Meetings)

### What shipped

- **Daily site log (Module D)**, internal team only.
  - **Weather:** filled in automatically from Open-Meteo, which is free and needs no key.
  - **Crew:** manpower by trade, with "Same crew as yesterday" to carry it forward in one tap.
  - **The day's record:** work done, inspections, delays, deliveries, visitors, safety incidents and notes.
  - **Photos:** straight from the phone camera, linked to the day's log.
  - **Nudge:** a reminder at 5pm New York time on active site days (weekdays in pre-construction, construction and TCO/CO) if no log has been filed.
  - **PDF:** any date range as one file, for a lender draw or a claim.
- **Schedule and baseline (Module E).**
  - **Gantt:** planned dates, the critical path (the chain with no slack), forecast bars and baseline bars. Phases that are fully done fold away.
  - **Forecast:** work that has started uses its real start date, and overdue work finishes today at the earliest.
  - **Baseline:** locked automatically when a project enters pre-construction. The locked finish is the forecast at that moment, so a fresh baseline reads "On baseline".
  - **Re-baselining:** team members request it with a reason and the owner approves. The owner's own request is approved at once, and every baseline is numbered and kept.
  - **Slippage:** "N days behind" shows on the tab and as a chip on the portfolio card.
- **RFIs (Module F).**
  - **Numbering:** numbered per project, with from/to, due date, discipline and attachments.
  - **Answering:** answered in place; an outside architect or engineer can answer the RFIs addressed to them.
  - **Change orders:** "Convert to change order" carries the RFI into Financials and notifies the money approvers.
  - **Cost:** cost impact is hidden from anyone without financial access.
- **Submittals:** revision history (Rev 0, 1, 2 …), with decisions of approved, approved as noted, revise and resubmit, or rejected. A resubmission opens the next revision.
- **Drawings.**
  - **Sets:** issued as sets of PDF sheets; the sheet number is read from the file name.
  - **Superseding:** a new set supersedes the discipline's current set, and superseded sheets are stamped SUPERSEDED.
  - **Viewer:** built in (PDF.js legacy build, so older iPhones work), with zoom and pages.
  - **Punch pins:** drop a pin straight onto a sheet.
- **Punch list (Module K).**
  - **Items:** each has a pin or not, a photo from the camera, floor, unit, trade, sub, assignee and due date.
  - **Filters and PDF:** filter by floor, unit, trade, sub or status, and download a PDF per sub.
  - **Subs:** an outside sub sees only the items assigned to them. They can mark them "Ready for review", and only the team can close.
- **Meeting minutes (Module G).**
  - **Meetings:** OAC, subcontractor, safety and internal meetings are numbered per type, with attendees (team members plus guests).
  - **Items:** discussion items and action items; an action item becomes an assigned task with a due date.
  - **Carry forward:** a new meeting brings in the last meeting's open items.
  - **Minutes:** download as a PDF.
- **Outside collaborators** see RFIs, submittals, drawings and punch, and not the daily log, schedule or meetings.

### Review

The independent review found 3 P1, 10 P2 and 10 P3 issues, and no P0. It checked the export routes and signed media links and found they apply the same access rules as the app. Every finding is fixed, with regression tests, except one P3 kept by design (below).

The P1s were:

- **The baseline covered only phases already begun.** Later phases' tasks had no dates yet, so the day Construction started, the card showed months of false slippage. Now every task in a phase that hasn't started gets a projected date: each phase starts the day after the one before it is projected to end. The baseline, the forecast and the Gantt cover the whole job, and projected bars are drawn lighter.
- **Finished action items kept carrying forward.** An action item now counts as done once its task is done, wherever it was ticked off.
- **Two people filing the same day's log could overwrite each other.** A second "new" log for a day that already has one is refused, with a prompt to reload.

The P2s and P3s fixed:

- **Earlier minutes rewritten:** carrying items forward marked them "Done" in the earlier minutes. They now read "Carried" there and are edited only in the new meeting.
- **Hidden attachment names:** RFI and submittal attachments in folders the viewer can't open are no longer named. They see "in a folder not shared with you" instead.
- **Punch photos:** an edit to a punch item can't attach another project's photo.
- **Closed punch items:** a sub can't reopen an item the team closed. The dialog is read-only for them.
- **RFI answers:** an RFI that's already answered or closed can't be answered again.
- **PDF page breaks:** long notes and long table cells continue onto the next page instead of running off the bottom.
- **Site-log PDF range:** a range over six months is refused, instead of silently stopping at 62 logs.
- **Drawing versions:** each sheet now stores the file version it was issued with, so a later upload doesn't change an issued set or move its pins.
- **Blank sheets on iPad:** the sheet viewer caps canvas size under iOS Safari's limit, so zoomed sheets no longer render blank.
- **One current baseline:** there is exactly one current baseline per project. A shared lock covers every path that creates one, and a database index backs it up.
- **Punch PDF filter:** the punch PDF now honours the status filter.
- **Pin counts:** outsiders' open-pin counts include only their own items.
- **Action item to note:** changing an action item to a note removes its task if the task hasn't started. Reopening an item reopens its task.
- **Date range:** dates must fall between 2000 and 2100, so a mistyped year can't blow up the Gantt.
- **Site-log photos:** they get a foreign key and an index, and punch sheets and meeting tasks get indexes.
- **Portfolio slippage:** it loads in three queries in total instead of three per project.
- **Outsider photos:** outsiders can't attach photos to internal site logs.
- **Upload failures:** submittal and RFI upload failures now show an error instead of saving without the file.

Kept by design: editing an open action item whose task was deleted creates the task again. An action item always has an owner, a date and a task.

### Test results

- 2,481 unit and integration tests pass. This milestone adds `tests/unit/schedule.test.ts`, `tests/unit/field.test.ts`, `tests/unit/pdf.test.ts`, `tests/integration/field.test.ts` (14 tests), projection tests in `tests/unit/templates.test.ts`, and permission-matrix rows for every new procedure.
- 33 of 33 Playwright end-to-end tests pass, including `tests/e2e/construction.spec.ts`:
  - the super files a log
  - the owner checks the schedule against the baseline, issues a drawing set, drops a punch pin, filters punch and adds a meeting action item
  - the outside architect answers an RFI
- Lint and typecheck are clean.
- Checked visually at desktop (1440px) and iPhone (390px) sizes on all seven Construction views, with no console errors and no sideways scrolling.

### Known limitations

- Weather is Open-Meteo's modelled data for the site (free, no key), filled in on the first save when the project has map coordinates. It is not a certified weather record for a claim, and it isn't editable on screen yet.
- The Gantt uses each task's own dates and its "blocked by" links (from Milestone 4). There's no drag-to-reschedule; tap a task to set its dates.
- A drawing's sheet number comes from the file name (for example "A-201 Level 2 plan.pdf"). To fix a wrong number, rename the file and issue it again.

## Milestone 8 — Public records watch, expiries and violations (done)

**Live:** https://ariel-dev-projects.vercel.app (each project's Public Records tab; Dates & Expiries tab; red flags on cards and the Needs-you rail)

### What shipped

- **17 NYC Open Data sources per BBL**, each dataset id and field checked against live Socrata metadata. The details are in `docs/RECORDS.md`. The check ran through the `Records probe` GitHub workflow, because this build environment can't reach data.cityofnewyork.us.
  - DOB NOW and DOB BIS jobs
  - BIS and DOB NOW permits
  - DOB, ECB, DOB safety and HPD violations
  - HPD and FDNY vacate orders
  - DOB complaints (stop-work codes from the disposition table)
  - OATH summonses
  - 311
  - tax lien sale list
  - DOF property charges (one "past due" record)
  - ACRIS, two steps: legals → master
- **Nightly sync, 1–6am New York**, from the hourly tick.
  - **Fetching:** sequential requests with the app token. Every query has a stable sort order and is paged. Retries back off on 429/5xx and honour Retry-After.
  - **Time limits:** each run has a hard deadline, so a slow city service can't overrun the job.
  - **One at a time:** a lease stops the nightly run and "Check now" from syncing the same project at once.
  - **Failure handling:** a failed source is recorded and retried with growing backoff (1h, 2h … 12h). Admins get one alert a day, and the run shows red on System, so a failure is never silent.
  - **Schema checks:** every run re-checks each dataset's columns. If the city changes a dataset, the sync fails loudly instead of misreading it.
- **Diff and alerts.**
  - **First run:** it only records what is there; the lot's history is not news.
  - **After that:** it alerts on new filings, job status changes, issued permits, new violations, complaints and 311 reports, notable ACRIS recordings (deeds, mortgages, lis pendens, liens), tax arrears or a lien-sale listing, and anything resolved.
  - **Who hears:** the owner and the project's PM get one notice per project per run.
  - **Clean-up:** records that drop out of a complete pull for a week are closed.
- **Stop-work and vacate orders are critical.**
  - **What counts:** only the latest order per building that hasn't been rescinded and is recent.
  - **Delivery:** push and email to the owner and PM straight away, through quiet hours and push preferences.
  - **Email budget:** these emails are marked critical, so the budget never holds them, retries included.
  - **Visibility:** a red banner on the tab and a red line on the project card.
- **Violations are tracked to closure:** issued → hearing → fixed → certificate of correction → dismissed or paid.
  - **Source-driven:** the stage follows the source forward and never moves backwards. A case someone closed by hand stays closed.
  - **Hearings:** a hearing date becomes an "OATH hearing" key date with reminders, and it is marked done when the case closes.
  - **No duplicates:** DOB summonses at OATH don't open a second case.
- **"Create task from this"** on every alert: a task in the current phase, high priority and due tomorrow for an order, linked back to the record. Alerts can also be dismissed or shared on WhatsApp.
- **The Public Records tab** shows:
  - orders in force and alerts
  - violations
  - DOB jobs and permits, complaints and 311, OATH summonses
  - ACRIS, with "data as of" because the open data lags live ACRIS by one to two months
  - tax: the past-due amount is shown only to people with financial access
  - sync health per source
- **Every record has a source link.** Admins can "Check now" once every 10 minutes.
- **Changing a project's BBL or address** clears the old lot's records, cases and permit expiries, so the next run starts fresh.
- **Expiry tracker (Module B)** on the Dates & Expiries tab:
  - **What it covers:** permits, sheds, DOT, cranes, TCO, builder's risk, GL, umbrella, vendor COIs (GL, workers' comp, disability), loan maturity and extension options, rate caps, LPC permits, 1031 deadlines.
  - **Reminders:** at 30, 14 and 7 days, then daily once expired, to the owner and PM. Loan and deal deadlines only reach people with financial access.
  - **From public records:** live DOB permits feed in automatically, a renewal supersedes the old sequence, and expired history is never imported.
  - **Red flags:** expired items show red on the card and in the Needs-you rail.
  - **Vendor COIs:** an expired vendor COI flags that vendor on every live project they're on, through contracts or expiry items. A current COI of the same kind anywhere clears the flag.

### Review

The independent review found 13 issues: 5 P1, 6 P2 and 2 P3. All are fixed, with regression tests. The P1s were:

- old permits flooding the expiry tracker
- an unstable ACRIS document set
- historical stop-work complaints read as orders in force
- no time limit inside a project's sync
- stale records after a BBL change

The P2s were:

- rows lost to page limits
- hand-closed cases reopening
- race conditions between syncs
- flat backoff
- a daytime check skipping the night
- COI flags from finished projects

The P3s were:

- critical emails losing their flag on retry, and a re-imposed order not re-alerting
- unlabeled source links

### Test results

- **Unit:** 263 tests, 100% line coverage of `core/records.ts`. They include:
  - every source mapping, against rows shaped like the live data
  - the query formats per dataset
  - the order resolution
  - the diff rules
  - the expiry reminder marks
- **Integration:** 1,810 tests, all 14 records tests and 4 expiry tests among them. They run against a scripted NYC Open Data and cover:
  - first run vs later runs, alerts and who hears them, re-runs never repeating
  - critical delivery through quiet hours with email
  - violations to closure with hearing dates, and hand-closed cases staying closed
  - create task, the lease and deadline, growing backoff, and superseded or expired permits
  - a BBL change, schema-change failures with an admin alert
  - expiry reminders, COI flags across projects (archived and renewed), and financial gating
  - the permission matrix for every new procedure
- **E2E:** 30 of 30. New:
  - records tab, violation update, task from an alert, expiries and the red flags
  - outsiders see neither tab
- **Visual checks:** desktop and iPhone size, with no horizontal page scroll, on the Portfolio (red flags and rail), Public Records, and Dates & Expiries.

### Known limitations

- **Vendor matching is by normalized name** until the vendor directory arrives (Module C, Milestone 10). "Acme Builders LLC" and "ACME Builders, L.L.C." match; two different companies with the same base name would too.
- **2,000 rows per source per lot.** Older rows beyond that aren't read, and the sync health shows the count.
- **DOF charges show a total, not each bill.** They are summarized as one "past due" record. The amount appears only on the tab, and only for people with financial access.
- **No stop-work-order dataset exists.** Orders come from DOB complaint dispositions and the HPD and FDNY vacate lists.

## Milestone 7 — Notifications (done)

**Live:** https://ariel-dev-projects.vercel.app (Settings → Notifications; Inbox; the Watch button on each folder; WhatsApp on every task and alert)

### What shipped

- **Web push, free.** It goes through each browser's own push service (Apple for the iPhone home-screen app, Google, Mozilla) using the VAPID keys stored in Vercel.
  - A service worker (`public/sw.js`) shows each push and opens its link: the task, file or approval.
  - It never opens a page outside this app.
- **This device** (Settings): turn push on or off, send a test push, and see and remove your devices.
  - The app re-checks this device each time it opens.
  - Signing out detaches the device, so the next person on it doesn't get your notifications.
  - Signing back in turns push back on without asking again. It stays off if you turned it off.
- **First-run prompt** (Portfolio, My Tasks, Inbox only):
  - On iPhone in Safari: "Add to Home Screen first", linking to the install guide.
  - In the installed app or a desktop browser: asks for permission after a tap.
- **Preferences:** push and email for each event, quiet hours (New York time) and the daily digest switch.
  - In-app is always on: the Inbox records everything.
  - Email exists only for the digest, approvals and the third overdue reminder (brief §3).
- **Delivery:**
  - Right after any request that created notifications, and hourly as a safety net.
  - Rows are claimed first, then sent outside any database transaction, so nothing is pushed twice.
  - A burst of four or more becomes one summary push.
  - Quiet hours hold push and release it as one summary when they end. Anything read in the meantime is dropped.
  - A file notice is checked against folder access again at the moment it is sent.
- **Daily jobs (New York time):**
  - digest at 7:00am: overdue, due today, approvals waiting, blocked; at most once a day; skipped when there's nothing
  - due-tomorrow reminders at 9:00am
  - overdue reminders every 2 days until the task is done or re-dated; the third copies the owner and emails both
- **Approval requests email.** While email is on hold, each one is recorded as "skipped" in the outbox and nothing is lost. The existing budget guard (80 soft / 100 hard) applies once email is on.
- **Folder watch:**
  - notices for new files and versions
  - a batch upload folds into one notice
  - people who can't see the folder (the gated Financial folder, or outsiders without a share) never hear about it
  - leaving a project ends your watches
- **WhatsApp share** on every task (task sheet) and every alert (Inbox). It opens the person's own WhatsApp with the text typed in.
- **No dollar figures** ever appear in push text, email subjects or WhatsApp text. Amounts like "$1,250,000", "$1.2M" and "($5,000)" become "an amount".

### Review

The independent review found 10 issues (1 P1, 4 P2, 5 P3). All are fixed, each with a regression test where one applies:

- P1: pushes and emails were sent inside the claiming transaction.
  - A timeout could roll back and re-send; slow push services could hold locks and connections.
  - Now it claims, commits, then sends.
- P2: every POST started a dispatch. Now only requests that wrote notifications do.
- P2: a digest re-run after a partial failure could send twice. Now once per person per day.
- P2: no grouping for live pushes. Bursts are now one summary.
- P2: push silently stopped after signing out and back in. It now re-subscribes without a prompt, respecting "turned off here". A device removed in Settings is not brought back by the re-check.
- P3: a held file notice could be pushed after access was revoked. Access is re-checked at send; watches end when you leave a project.
- P3: tapping a push when an app tab was open didn't navigate. Fixed; it falls back to a new window.
- P3: the "public-record changes" switch had no source. It is hidden until Milestone 8.
- P3: the email "—" cell was announced wrongly by screen readers. Fixed.
- P3: test gaps. Covered.

### Test results

- Unit: 215 tests
- Integration: 1,688 tests. New:
  - 18 notification tests: devices and the push-host allow-list, concurrent dispatch, bursts, quiet hours, preferences, approval email, due-tomorrow, the overdue schedule and escalation, the digest, and folder watches with access changes
  - the permission-matrix rows for every new procedure
- E2E: 28 of 28. New:
  - preferences save and reload
  - WhatsApp links carry no amounts and point at the task
  - watch and unwatch a folder
- Checked at 1440px and at iPhone size with no horizontal page scroll: My Tasks with the prompt, Inbox, Settings → Notifications.

### Known limitations

- **Real iPhone push isn't tested yet.** A real iPhone test of home-screen push is part of Milestone 12.
- **Email is on hold.** Approval, digest and third-reminder emails are recorded as "skipped" until a sender is chosen.
- **Photo uploads don't notify watchers.** Site photos come in batches from the field; folder watches cover documents.
- **Grouped push.** Only the newest few titles show in a summary push; the Inbox has everything.
- **Critical alerts come in Milestone 8.** Stop-work and vacate orders bypass quiet hours and the email budget; that path arrives with the public-records watch.

## Milestone 6 — Financials (done)

**Live:** https://ariel-dev-projects.vercel.app (each project's Financials tab, for people with financial access)

### What shipped

- **Headline:** purchase price, total project budget, spent to date, committed, forecast at completion, projected sellout, profit and margin, equity required (forecast less the loan) and a simple equity multiple.
  - Total budget and sellout come from the budget lines and unit schedule once you switch them on in Edit figures. Until then the typed figures are used, so a half-entered budget never swings the numbers.
  - Portfolio cards follow the same figures.
- **Budget:** the seven categories (acquisition, closing costs, soft, hard, financing, contingency, sales & marketing) with line items. Each line shows original, approved changes, revised, committed, invoiced, paid and variance (over or under).
  - A line's forecast is its revised budget plus any overrun by commitments or invoices.
  - Anything not coded to a line is totalled in its own row, so the headline never drops it.
- **Commitments:** contracts and POs by vendor, with retainage %. The contract value includes approved change orders written against it; billed and remaining are shown.
- **Invoices:** log one against a contract (it takes the contract's line and retainage) or code it to a line.
  - Upload the PDF; it lands in the restricted Financial folder, and linked documents can't be moved out or trashed.
  - Approval (A) or rejection with a note. Approvers get an in-app notice (no dollar figures).
  - Mark paid, or undo it.
  - An approver can reopen a mistaken approval for correction, as long as it isn't on a submitted draw.
- **Change orders:** amount (credits allowed) and schedule days, with approval (A). Approved change orders update the line's revised budget, and the contract's value too. Numbers are never reused.
- **Draws:** a requisition built from approved invoices, with retainage held back per invoice.
  - One lien waiver per vendor; they can be ticked but the list can't be replaced.
  - Draft → submitted (all waivers in) → inspector signed off → funded.
  - Fields lock as the draw moves on.
  - Total retainage held is shown for release at the end.
- **Sales tracker:** per unit sf, beds/baths, ask and contract price with $/sf, status (available, reserved, in contract, closed), buyer and dates. It rolls up into projected sellout.
- **Excel export**, owner only: Summary, Budget, Commitments, Invoices, Change orders, Draws and Sales sheets.
- All money maths lives in `src/core/financials.ts` and `src/core/money.ts`: integer cents, basis points, no floating-point money. The one exception is Excel cells, which hold dollars as Excel's own numbers.
- Every change is audited under financial entity types, which the activity feed hides from people without financial access.

### Review

The independent review found 17 issues (5 P0, 5 P1, 7 P2); all fixed, with regression tests:
- **P0:**
  - credit lines no longer look over budget
  - contract change orders now change what's committed
  - uncoded contracts and invoices are counted
  - a half-entered budget or unit list can't replace typed figures
  - approved invoices can be reopened for correction
- **P1:**
  - decisions only from the saved record (invoices and change orders open read-only first)
  - draw waivers can't be emptied or faked, and signed-off draws lock
  - invoice PDFs can't leave the Financial folder
  - amounts capped at $10B with per-project safety, so one bad project can't break the portfolio
  - numbers never reused
- **P2:**
  - retainage parsed exactly
  - version checks on the headline and every delete, with locked deletes
  - contract/line coding enforced
  - vendor names matched loosely for waivers
  - retainage held tracked
  - approvers notified
  - members with approve rights and financial access can approve
  - no negative equity multiples
  - accessible tabs
  - confirmation on every delete
  - a Rejected filter
  - inspector sign-off saves before advancing
  - the old headline editing path removed

### Test results

- Unit: 210 tests, including the whole money engine and the review regressions
- Integration: 1,562 tests, including:
  - the permission matrix for every Financials procedure (view with financial access; edit and approve only for the owner and admins with access; export owner-only)
  - the full budget → commitment → invoice → change order → draw flow to the cent
- E2E: 25/25. New:
  - owner: headline, budget, approve an invoice, build and submit a draw with lien waivers, Excel download
  - admin: sees the numbers but has no export
- Checked at 1440px and at iPhone size (393px) with no horizontal page scroll (wide tables scroll inside their card): Summary, Invoices, Sales

### Known limitations

- Retainage release is tracked as a total, not as its own requisition line.
- Buyer upgrades and finish selections per unit come with the condo unit tracker (Module L, Milestone 10).

## Milestone 5 — Files (done)

**Live:** https://ariel-dev-projects.vercel.app (each project's Files tab; attachments in every task sheet)

### What shipped

- **Folders:** every project gets its template's folders (brief §14): Acquisition, Legal, Title & Survey, Environmental, Design, DOB & Permits, Construction, Photos, Financial, Sales, Closeout.
  - Financial is **gated**: only people with financial access on the project ever see it or anything in it, including names in the activity feed and moves in or out.
  - Financial and Photos always exist, even if a template leaves them out.
  - Folders can be added, renamed and removed (empty ones) per project, and edited per template in the Template studio.
- **Uploads:**
  - straight from the device to private Blob storage, with signed tokens scoped to one object, its size and its type
  - up to 500 MB per file, with progress and a warning over 100 MB (storage is shared 10 GB)
  - multi-file and drag-and-drop on desktop, a file picker on iPhone
  - the upload window scales with file size, and leaving mid-upload asks first
- **Versions:** upload a new version of any file. Every version stays downloadable, with who uploaded it and when.
- **Previews:** image thumbnails made on the device, a full image preview, and an inline PDF viewer (the whole PDF opens with Open).
- **Downloads** are checked for access on every request, then served from a signed storage link that expires in 5 minutes. Anything that isn't an image or PDF is stored and served as a plain download, never rendered as a page.
- **Trash:** removed files are kept 30 days (restore puts them back everywhere), then purged automatically. Admins can delete for good, with a confirmation.
- **Task attachments:** upload onto a task or attach an existing file. A file lives in its folder and shows on the task.
  - A task with a required attachment routes one-tap complete to the attach step, and approval re-checks it.
  - Outside collaborators can upload onto their own tasks even with no folders shared. The file is filed by the task's phase and they see it only on the task.
- **Sharing with outside collaborators:** admins share folders one by one. Outsiders see only shared folders; site photos follow the Photos folder, and they get no hero photos they can't open.
- **Virus-scan hook:** set `VIRUS_SCAN_URL` to have every upload checked before it's recorded. A flagged file is deleted and refused. No free hosted scanner exists that fits the $0 rule, so by default files are recorded "not scanned".

### Review

The independent review found no P0 issues, 6 P1 and 12 P2; all fixed, with regression tests:
- **P1:**
  - uploads of HTML or SVG are stored as plain downloads, so they can't run on the storage domain
  - Financial and Photos folders are guaranteed
  - long uploads get a longer window
  - outsiders' cards no longer show broken hero images
  - outsiders can attach to their own tasks
  - a confirmation before deleting for good
- **P2:**
  - two purges at once count the bytes back once
  - thumbnail paths can't collide
  - non-Latin file names keep their extension
  - gated attachments can't be detached without financial access
  - approval re-checks required attachments
  - the download route uses a light access check and a 4-minute cached redirect
  - scanning only when configured, after the upload is claimed
  - drops outside the zone never navigate away
  - the large-file warning on new versions
  - "complete" rolls back before routing to the attach step, including from My Tasks
  - honest trash wording
  - download URLs are covered by permission tests for every role
  - PDF preview on phones

### Test results

- Unit: 196 tests
- Integration: 1,308 tests, including:
  - the permission matrix for every Files procedure
  - a download-route matrix (anonymous, owner, members with and without financial access, outsiders with and without shares, unassigned)
  - the review regressions above
- E2E: 23/23. New:
  - upload into a folder, preview, new version, rename, trash and restore
  - a required-attachment task routes to the attach step, then completes
  - sharing a folder with the architect, who then sees only that folder
- Checked at 1440px and at iPhone size (393px) with no horizontal scroll: folder list, folder view, file sheet with preview

### Known limitations

- The virus scan is a hook, not a scanner (no free hosted option); see above.
- A renamed file downloads under its original file name; the app shows the new name everywhere.

## Milestone 4 — Tasks (done)

**Live:** https://ariel-dev-projects.vercel.app (My Tasks, Inbox, the Needs-you rail on Portfolio, and each project's Checklist and Key Dates tabs)

### What shipped

- **Task sheet:**
  - assignee (anyone on the project) and priority
  - status: To do / Doing / Waiting on a third party (who, e.g. "Expediter — DOB plan exam") / Blocked (why)
  - approvals: approve or send back with a note
  - repeats weekly, every 2 weeks or monthly
  - watchers, including sharing a single task with an outside collaborator
  - comments with @mentions (type @ and pick a name; only people who can see the task are offered)
- **Waiting on a third party follows up by itself:** every 2 business days the assignee gets a nudge naming who they're waiting on.
- **Approvals** go to the person in the task's approver role on the project, or the owner. It's worked out at each request and re-routed if that person is removed, deactivated or loses approve rights. Only that person or the owner decides, and anyone else's tick sends it for approval.
- **Recurring tasks:** completing one creates the next occurrence on the next business day. Reopening it removes exactly the one it created, as long as nobody has touched it.
- **Bulk actions on the checklist:** Select, then reassign, re-date or shift by N business or calendar days. Each phase also has **Shift** to move all its open dates at once. Done tasks are never moved.
- **My Tasks:** Overdue / Today / This week / Later / Waiting on others / Awaiting my approval, grouped by project with its photo. One tap completes, and long sections fold.
- **Needs you** on Portfolio: approvals waiting on me (with Approve), blocked tasks, overdue by person, and key dates in the next 14 days. Public-record alerts join in Milestone 8.
- **Cards and table:** next action and its owner, blocked and overdue counts, next key date. The project Overview has a "What's next" panel.
- **Key Dates tab:** DD expiry, closing, TOE, TCO expiry, loan maturity, the 1031 deadlines, auction and custom dates. The team gets in-app reminders 14, 7 and 1 day before each date, sent once each, with missed days caught up.
- **Inbox:** in-app notifications for assignments, mentions, comments, approval requests and decisions, unblocked tasks, follow-ups and key dates. There's an unread badge in the sidebar and the iPhone tab bar, and every notification links straight to the task.

### Review

The independent review found 15 issues; all fixed, with regression tests:
- **P0:** someone removed from a project kept getting that project's task notifications, including comment text. Removal now drops their shares, unassigns their open tasks and re-routes their approvals, and notifications only ever reach people currently on the project.
- **P1:**
  - an outside approver (e.g. the lender) can now open and decide the approval routed to them
  - approvers are re-resolved at each request, and re-routed when they can no longer act
  - only the routed approver or the owner decides
  - reopening an older occurrence no longer deletes the current one
  - outside collaborators can't share tasks with themselves
  - recurrence can be set on any task
  - notification paging never skips notifications created at the same moment
- **P2:**
  - approvals pending from before this release go to the owner
  - bulk edits lock their rows and run as one statement
  - key-date reminders are logged per threshold
  - true counts on the rail
  - every view refreshes after any task change
  - an accessible unread badge
  - comment editing in the UI, admin removal, and removed comments scrubbed from notifications
  - an index for recurring series

### Test results

- Unit: 192 tests
- Integration: 1,055 tests, including the permission matrix for every task, key-date and notification procedure (each role, assigned/unassigned, financials on/off) and the review regressions above
- E2E: 21/21. New:
  - owner: Needs-you, approve from the rail, add a key date, bulk shift
  - member: My Tasks, waiting on a third party, @mention; the mention lands in the other person's inbox and opens the task
- Checked at 1440px and at iPhone size (393px) with no horizontal scroll: Portfolio with the rail, My Tasks, task sheet, Key Dates, Inbox

### Known limitations

- Push, the daily digest, quiet hours and preferences come in Milestone 7. Until then notifications are in-app only.
- Required attachments are shown and enforced from Milestone 5 (Files).

## Milestone 3 — Templates, phases, checklists, toggles (done)

**Live:** https://ariel-dev-projects.vercel.app (Templates in the sidebar for the owner and admins; each project's Checklist tab)

### What shipped

- **Starter library (§5.4)** as seed data: every task from the brief with a default role, a relative due date (business days, skipping weekends and federal holidays), prerequisites, approvals (A), kill screens, milestones, recurring construction tasks and sub-checklists. The toggle tags from the brief are conditions. One default template per project type, including the contract-flip and foreclosure-auction tracks; "rental hold" swaps AG Plan & Sales for Rental / Hold.
- **New project in two steps:** the property, then the site-condition questions (landmarked, MIH, E-designation, occupied, demolition, excavation, construction loan, JV, tax incentive, rental hold, 1031, flood zone, violations) with a live count of the checklist it will generate, and a choice of template.
- **Checklist tab:**
  - phases with progress; the current phase opens first
  - one-tap complete (optimistic); a task with unfinished prerequisites shows a lock and "Waiting on …" and says why if tapped; approval tasks go to "Awaiting approval" unless you can approve
  - due dates appear when a phase starts or a prerequisite finishes; manual dates are never overwritten; overdue items are flagged with an icon and text
  - task sheet: edit title, role, phase, due date, notes, approval, sub-checklist and prerequisites (loops refused, with the loop spelled out); move up/down; delete
  - drag to reorder on desktop, up/down buttons everywhere
  - add tasks inline; add and rename phases
  - **Site conditions** dialog with a live preview of every task and phase a change adds or removes; started tasks are removed only if you tick them
  - **Save as template**, and a banner with a reviewed **Apply template update** when the template has moved on
- **Template studio:** list by project type (default, duplicate, archive), and an editor for phases (drag or up/down, conditions), tasks (role, due rule, approval, prerequisites with loop prevention, sub-items, attachment, repeat, kill screen, milestone, show/hide conditions), a "generate for a test project" preview with dates, and projects using the template with a per-project diff and apply. Every save is a new version; live projects are never rewritten silently.
- Portfolio and project **% complete** now credit the current phase's checklist.

### Review

The independent review found 12 issues; all fixed with regression tests:
- **P0:** checking off a blocked task could name hidden prerequisites to an outside collaborator. It now names only what they can see and counts the rest; their phase counts are their own tasks only.
- **P1:**
  - template updates are now a true three-way diff: hand edits and hand deletions stay; rule, role and other field changes do apply
  - a condition that adds a prerequisite now wires existing tasks to it
  - prerequisite edits are serialized per project so no loop can form
  - save-as-template keeps flags and conditions and always produces a valid template
  - members with checklist rights can review and apply updates
- **P2–P3:**
  - approval can't be removed or an approved task reopened without approve rights
  - applying an update checks the reviewed version and shows the full list
  - the task sheet no longer loses typing; sub-items can be ticked by whoever works the task
  - honest date hints; reopening reschedules
  - stale site-condition previews are refused

### Test results

- Unit: 192 tests (template engine, calendar and holidays, dependency graph, the library's validity, three-way diffs, save-as merge)
- Integration: 780 tests, including the permission matrix for every checklist and template procedure, and the regressions above
- E2E (Playwright, desktop plus iPhone-sized): 19/19. New: create with conditions and live count, blocking and completion, task sheet, prerequisites, site-condition removal preview, Template studio save, outside collaborator's empty checklist, iPhone one-tap complete with no horizontal scroll

### Known limitations

- Assignment to people, comments, @mentions, watchers, approval decisions with notes, recurrence roll-forward, My Tasks and key dates arrive in Milestone 4 (this milestone's checklist uses roles).
- Required attachments are shown but can't be satisfied until Files (Milestone 5).

## Milestone 2 — Projects & Portfolio (done)

**Live:** https://ariel-dev-projects.vercel.app/portfolio

### What shipped

- **Portfolio**, four views, with the view, filters and search kept in the URL:
  - **Cards:** hero photo (or the address in serif), phase track with "Phase X of N", % complete, days in phase, company, status, and headline figures only for people with financial access
  - **Table:** sortable-looking dense list with thumbnails; scrolls inside its frame on a phone
  - **Timeline:** phase Gantt across projects, opens on today; the current phase is hatched and marked ▸ as well as colored
  - **Map:** MapLibre with OpenFreeMap's Positron tiles (free, commercial use allowed, no key). If the map can't load (offline or no WebGL), a plain plot of the pins shows instead
  - Filters for phase, type, company, person (internal team only) and status; search by name, address or BBL; archived projects view
- **Projects:**
  - create and edit: address, borough, BBL, type, company, status, key facts (lot, zoning, residential and built FAR, unused ZSF, units, gross and sellable SF) and notes
  - headline financials (purchase price, budget, projected sellout), editable by the owner or admins with financial access
  - address lookup via NYC Planning GeoSearch (free, no key): map pin, and a blank BBL is filled when the city's data has one in the right borough
  - optimistic locking: a stale edit is refused with "Someone else changed this project…"
  - archive and restore (nothing is deleted)
- **Phases:** each project type gets its track (standard 11 phases, contract flip, foreclosure auction). A stepper lets people who can edit the project make a phase current (forwards or back, with a confirmation for going back) or skip / restore a phase.
- **Site photos:**
  - compressed on the device (2560px WebP, JPEG on Safari, ~80%) plus a small copy for cards
  - capture date from the photo's EXIF, never the file's modified time
  - direct upload to the private Blob store with a token limited to the exact file path, size and type; the server checks the stored files before recording them; double submits and double removes are harmless
  - storage metered; uploads refused at 95% of the Blob budget, counting uploads still in progress
  - served only through an access-checked route, cached privately for 10 minutes
  - newest photo is the hero unless an admin pins one; uploader or admin can remove
  - abandoned uploads are cleaned up hourly
- **Activity tab:** the project's history; money entries are hidden from anyone without financial access; outside collaborators don't get the feed.
- The other project tabs (Checklist, Key Dates, Files, Public Records) show designed "coming next" states until their milestones.

### Review

An independent review found no financial leaks. It found 14 issues, all fixed:
- editing from a cold page load could silently switch the company (the form now waits for the company list; e2e test added)
- simultaneous upload completions or removals could duplicate photos or skew the storage meter (atomic claim, unique object key, delete-returning)
- the 95% stop ignored uploads in progress
- wrong "Phase X of N" with skipped phases, a stale search box after clearing filters, archived projects unreachable when everything was archived, BBL not filled on edit
- polish: photo remove button rule, restored-phase wording, timeline on phones and color-only cues, table thumbnails, EXIF capture date, photo cache length

### Test results

- Unit: 171 tests (`src/core` ≥ 98% lines)
- Integration: 455 tests against Postgres, including the permission matrix for every new procedure, financial gating in list, get and activity, upload verification, concurrency, budget and cleanup, and the photo route
- E2E (Playwright, desktop Chromium plus an iPhone-sized viewport): 14/14. Covers views, filters, search, create, phase change, stale-edit conflict, photo upload, activity, archive/restore, money hidden from a member without the flag, cold-load edit, and no horizontal scroll on iPhone

### Known limitations

- Next action, blockers, overdue counts and key dates on cards arrive with tasks (Milestone 4).
- The map tiles can't be reached from the build sandbox, so the live map was checked through its fallback here; it loads from OpenFreeMap in the browser.
- **Preview deployments share the production database and don't run migrations**, so a preview can be broken until its milestone reaches `main`. Milestones are checked locally and on production. Neon's free "preview branching" in the Vercel integration would give each preview its own copy (optional).

## Milestone 1 — Foundation (done)

**Production URL:** https://ariel-dev-projects.vercel.app (no custom domain). Branch previews are at `project-tracker-git-<branch>-jonch95-oss-projects.vercel.app` and sit behind Vercel Authentication.

### What shipped

- **Repo and CI** (`.github/workflows/ci.yml`), on every PR and push to `main`:
  - lint and typecheck
  - unit tests with coverage thresholds
  - integration tests against Postgres
  - production build
  - Playwright on desktop Chromium and iPhone WebKit
- **Database:** Drizzle schema and migrations.
  - Migrations run automatically on production builds (`scripts/vercel-build.mjs`).
  - The audit log is append-only, enforced by database triggers.
- **Auth** (Better Auth):
  - invite-only email and password
  - password reset
  - optional TOTP 2FA with backup codes
  - passkeys (Face ID / Touch ID)
  - rate limits on sign-in, reset and 2FA
  - deactivation ends every session immediately
- **Invites:** single-use hashed tokens that expire in 7 days. They can be revoked or resent, and the link can be shared by hand, for example by WhatsApp.
  - A one-time `/setup` page creates the first owner on the empty production database. It needs the `SETUP_KEY` env var and works only while no user exists.
  - With email on hold, the owner can create a one-hour **password reset link** for anyone from Team & permissions.
- **Roles and permissions:**
  - owner, admin, member and outside collaborator
  - per-project project role, `canViewFinancials`, `canEditChecklist` and `canApprove`
  - enforced in tRPC middleware
  - unassigned users get "not found", so they can't tell a project exists
  - outside collaborators never see other people's emails or permission flags
- **Audit log:** hash-chained (the actor's name is part of the hash), with an owner page that has search, filters and a "Verify integrity" button. The nightly backup also stores an off-database anchor (latest seq and hash), so a truncated or rewritten log is caught on restore.
- **Design system:** tokens for light and dark, with WCAG-safe text variants of bronze, sage and ochre.
  - Hand-drawn hairline icons and a component kit, shown at `/system/design`.
  - An address-in-serif placeholder in place of photos.
  - App shell with a desktop rail and an iPhone bottom tab bar that respects safe areas.
- **Screens:**
  - sign in, 2FA challenge, forgot and reset password, invite acceptance, setup
  - Portfolio: basic cards and a create-project dialog
  - My Tasks: designed empty state
  - Project page shell with a Team tab for access and flags
  - Team & permissions, Settings (profile, password, 2FA, passkeys), Audit log, System
  - iPhone install guide
- **Infrastructure** (Change Order 01): Vercel Pro only, no Cloudflare.
  - Vercel Cron calls `/api/jobs/tick` hourly.
  - Storage sits behind an interface (`src/server/storage`) with Vercel Blob (private) and in-memory adapters.
  - A nightly GitHub Actions `pg_dump`, encrypted with AES-256, goes to a **separate** private Vercel Blob store, keeping 30. A restore-drill workflow restores the latest one into a throwaway Postgres and verifies the audit chain against the anchor.
- **System page** shows usage against:
  - Neon storage
  - the Blob storage and download budget (uploads refused at 95%)
  - email per **UTC** day and per month (email is on hold; see below)
  - GitHub Actions minutes
  - the team's $20 Vercel Pro credit, once a read-only token is supplied

  A "Needs attention" panel at the top lists anything over 70%, failed jobs in the last 24 hours and missing backups. It also shows job runs, grouped errors, the email outbox and backups. Alerts at 70%, 90% and 100% go to the owner (by email once a sender exists; by push and in-app from Milestone 7).
- **Errors:** logged to `error_log`, with a daily summary to the owner. The Sentry free plan allows business use for one user; it stays optional.

- **Review fixes** (all P1 and P2 findings, and most P3):
  - Client IPs come only from Vercel's own headers, so rate limits and audit IPs can't be spoofed.
  - Email is behind a mailer interface with a no-op adapter. Nothing is sent, and no message body or token is stored.
  - Admins can't change owners' or other admins' access, or grant financial visibility they don't have.
  - Invite acceptance is all-or-nothing; sign-ins are audited only when complete; one shared password rule everywhere.
  - Hourly tick has a lock, closes stale runs, and alerts if production has gone 36 hours without a backup.
  - Production redirects any other host to https://ariel-dev-projects.vercel.app, and sign-in returns you to the page you asked for.
  - Destructive actions ask for confirmation; invite, new and reset links open a share dialog (copy or WhatsApp).
  - Contrast, control borders, type scale, touch targets (40 px+ on iPhone), reduced motion and tab semantics fixed.

### Test results

- Unit: 120 tests; `src/core` at 100% lines and ≥98% branches.
- Integration: 305 tests against real Postgres, including:
  - the permission matrix: every procedure × 12 role/flag/assignment scenarios, plus a check that every procedure is covered
  - auth, 2FA end to end, invites, audit immutability and tamper detection, the email budget and no-op sender, usage alerts, jobs (tick lock, stale runs, backup watch) and setup
- E2E (Playwright, desktop Chromium): 9/9. The iPhone WebKit project runs in CI.
- Restore drill: **passed against production.** The nightly workflow dumped Neon (Postgres 18), encrypted it and stored it in the `project-tracker-backups` Blob store. The restore-drill workflow decrypted it, restored it into a throwaway Postgres 18 (1 user, 3 audit entries, 3 migrations), confirmed the audit log is still append-only, and verified the hash chain against anchor #3. See `docs/RESTORE.md`.

### Known limitations / pending

- **Setup key retired:** Vercel's API has no delete for environment variables, so `SETUP_KEY` was overwritten with a random value nobody knows. `/setup` also refuses once any user exists. Deleting the variable in Vercel is optional tidying.
- **Workflow triggers:** the GitHub integration can't press "Run workflow", so the backup and restore-drill workflows also start when `ops/triggers/backup` or `ops/triggers/restore-drill` changes on `main`.
- **Vercel Pro has no separate Blob allowance.** Blob bills from the team's shared $20 credit. The app budgets 10 GB stored (about $0.23/month) and 20 GB/month of downloads. The team spend budget is $20 with production pausing on.
- **Email is on hold.** Invites and resets are on-screen links; notifications go by push, in-app and WhatsApp share (Milestone 7).
- **Not done from the review:** a strict nonce-based Content-Security-Policy `script-src` (Milestone 13 hardening) and client-side error reporting.
