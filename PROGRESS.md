# Progress

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
