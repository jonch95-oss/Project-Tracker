# Progress

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
