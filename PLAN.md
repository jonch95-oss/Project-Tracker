# Project Command — Build Plan

Private development-project tracker for Ariel Development Group / Lian Development JV Group.
The source of truth is `docs/BRIEF.md` (updated by Change Order 01). This plan builds it in 13 milestones, one at a time. Each milestone meets its Definition of Done before the next starts:

- tests green
- review-subagent findings fixed
- deployed to preview
- checked on desktop and on an iPhone-sized viewport
- `PROGRESS.md` updated

## Guiding constraints

- **No added monthly cost.** The app uses what Vercel Pro already includes. Every other service stays on a permanent free tier that allows business use.
  - The System page shows live usage against each limit or allowance.
  - The owner is emailed at 70%.
  - A Vercel team spend cap stops silent overage.
- **Server-side permissions.** Every tRPC procedure passes through the permission middleware in `src/server`. Financial data never leaves the server unless `canViewFinancials` is set.
- **Pure core.** All business logic lives in `src/core`, with no I/O and full unit tests.
- **Adapters for every external service.** Storage, mail, push, public records and inbound mail each sit behind an interface with a local mock. The app never connects to the deal-origination platform. No missing credential blocks the build.
- **Time zone:** `America/New_York` for every "today", due date, digest and schedule.

## Stack

| Layer | Choice |
|---|---|
| Hosting | Vercel Pro, project `project-tracker` on team "jonch95-oss' projects". Domain `projects.liandev.com` |
| App | Next.js 16 (App Router, TypeScript), React 19, installable PWA |
| API | tRPC 11, TanStack Query 5, superjson, zod 4 |
| Auth | Better Auth 1.7: invite-only email/password, reset, TOTP 2FA, passkeys |
| DB | Neon Postgres Free, connected through Vercel Storage; Drizzle ORM and migrations |
| Files | Vercel Blob, private store. Uploads go direct from the client with signed tokens, and files are read via server-authorized short-lived access. `src/server/storage` holds the interface plus Blob and memory adapters |
| Email | Resend Free: outbox table, budget guard per UTC day, console adapter in dev |
| Scheduled jobs | Vercel Cron → `GET /api/jobs/tick` hourly. The tick runs what is due: nudges, digest, weekly report, records sync, expiry checks. Jobs are batched so each run stays under `maxDuration` |
| CI and backup | GitHub Actions: CI on PRs and main, plus a nightly `pg_dump` → Vercel Blob (30 kept) |
| Errors | `error_log` table and a daily owner summary. The Sentry free plan allows business use for one user; its adapter is optional |
| Tests | Vitest (unit, and integration against real Postgres); Playwright (desktop Chromium and iPhone WebKit) |

## Allowances (checked 2026-09-23)

| Service | Limit used for alerts | Notes |
|---|---|---|
| Neon Free | 0.5 GB storage | Hard cap; scales to zero, so expect a cold start |
| Vercel Blob | App budget of 10 GB stored and 20 GB/month downloads | Pro has **no separate Blob allowance**: usage bills from the first byte against the team's shared $20 credit (storage $0.023/GB-month, transfer $0.05/GB). Uploads stop at 95% |
| Vercel Pro credit | $20/month across the whole team | Measured with a read-only `VERCEL_USAGE_TOKEN` |
| Resend Free | 100/day (UTC day), 3,000/month | Sent and received mail both count. Non-urgent mail is held above 80; stop-work and vacate alerts always send |
| GitHub Actions | 2,000 min/month | CI plus the nightly backup only |

## Milestones

1. **Foundation**
   - repo and CI
   - database and migrations
   - auth, invites and roles
   - hash-chained audit log
   - design tokens and component kit
   - Vercel deploy, error logging, System page
2. **Projects & Portfolio**
   - create and edit projects, hero photos
   - card, table, timeline and map views
   - project page shell
3. **Templates, phases, checklists, toggles**
   - Template studio
   - the full seed library from §5
4. **Tasks**
   - statuses, dependencies, approvals, recurrence
   - comments and @mentions
   - My Tasks, Needs You rail, key dates, bulk actions
5. **Files**
   - Blob, folders, versions, previews
   - task attachments, gated Financial folder
6. **Financials**
   - everything in §8, with Excel export
7. **Notifications**
   - in-app, push, email budget, digest
   - 2-day nudges, WhatsApp share, preferences, quiet hours
8. **Public records, expiries, violations**
   - §10: every Socrata dataset, critical stop-work and vacate alerts, violation lifecycle
   - Module B
9. **Field and construction**
   - Modules D, E, F, G and K: daily log, baseline and critical path, RFIs, submittals, drawings, minutes, punch pins
10. **Directory, BBL auto-fill, investors, units**
    - Modules A (BBL auto-fill from PLUTO only; never connects to the deal platform), C, J and L
11. **Calendar, email-in, analytics, import**
    - Modules H, I, M and N
12. **iPhone home-screen app**
    - §12 and every field module, tested on a real iPhone
13. **Reports, search, polish, launch**
    - weekly report, ⌘K search
    - full pressure test (§13), cut-over, README and team guide

## Code layout

```
src/core            pure logic (permissions, money, time, free-tier math, audit hashing, …)
src/server          db, auth, tRPC routers + permission middleware, services, storage adapters
src/app             routes: (auth), (app), api/auth, api/trpc, api/jobs
src/components/ui   component kit on src/styles/tokens.css
drizzle/            migrations (including the audit-log protection triggers)
scripts/            migrate, bootstrap-owner, seed-demo (demo only), ops (backup, restore drill)
tests/              unit, integration (permission matrix), e2e
```
