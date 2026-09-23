# Progress

## Milestone 1 — Foundation (in review)

**Preview / production URL:** https://project-tracker-jonch95-oss-projects.vercel.app. It sits behind Vercel Authentication, so sign in with your Vercel account. `projects.liandev.com` will serve it once the DNS record is live.

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
  - A one-time `/setup` page creates the first owner on the empty production database. It needs the `CRON_SECRET` and works only while no user exists.
- **Roles and permissions:**
  - owner, admin, member and outside collaborator
  - per-project project role, `canViewFinancials`, `canEditChecklist` and `canApprove`
  - enforced in tRPC middleware
  - unassigned users get "not found", so they can't tell a project exists
  - outside collaborators never see other people's emails or permission flags
- **Audit log:** hash-chained, with an owner page that has search, filters and a "Verify integrity" button.
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
  - A nightly GitHub Actions `pg_dump` goes to Vercel Blob, keeping 30.
- **System page** shows usage against:
  - Neon storage
  - the Blob storage and download budget (uploads refused at 95%)
  - Resend per **UTC** day and per month
  - GitHub Actions minutes
  - the team's $20 Vercel Pro credit, once a read-only token is supplied

  It also shows job runs, grouped errors, the email outbox (held and failed mail is never dropped) and backups. The owner is emailed at 70%, 90% and 100%.
- **Errors:** logged to `error_log`, with a daily summary to the owner. The Sentry free plan allows business use for one user; it stays optional.

### Test results

- Unit: 102 tests; `src/core` at 100% lines and ≥98% branches.
- Integration: 286 tests against real Postgres, including:
  - the permission matrix: every procedure × 12 role/flag/assignment scenarios, plus a check that every procedure is covered
  - auth, 2FA end to end, invites, audit immutability and tamper detection, the email budget, the usage alerts, jobs and setup
- E2E (Playwright, desktop Chromium): 9/9. The iPhone WebKit project runs in CI.
- Restore drill: done locally from a file. **Still to redo against Vercel Blob** once the Blob store is connected.

### Known limitations / pending

- **Vercel Blob store:** not created yet. My Vercel access can't create stores, so it needs one click in the dashboard.
- **Vercel spend cap:** not set yet. Vercel's API doesn't let me set it; see the instructions in the handoff.
- **Vercel Pro has no separate Blob allowance.** Blob bills from the team's shared $20 credit. The app budgets 10 GB stored (about $0.23/month) and 20 GB/month of downloads.
- **Resend and domain email:** not connected. Until then, mail goes to the outbox and invites show a copyable link.
