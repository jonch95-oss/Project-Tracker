# Progress

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
