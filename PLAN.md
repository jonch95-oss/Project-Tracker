# Project Command — Build Plan

Private development-project tracker for Ariel Development Group / Lian Development JV Group.
This plan implements the build brief milestone by milestone. Each milestone must meet its Definition of Done
(tests green, review-subagent findings fixed, preview deployed, desktop + iPhone viewport checked,
`PROGRESS.md` updated) before the next one starts.

## Guiding constraints

- **$0/month running cost.** Every service is on a permanent free tier that allows business use. Nothing auto-upgrades.
  Usage vs. limits is shown live on the owner-only **System** page; a scheduled job emails the owner at 70%.
- **Server-side permissions.** Every tRPC procedure passes through permission middleware in `src/server`.
  Financial data never leaves the server unless `canViewFinancials` is true for that user on that project.
- **Pure core.** All business logic (permissions, templates, toggles, dependencies, dates, money, nudges,
  free-tier math, audit hashing) lives in `src/core` with no I/O and full unit-test coverage.
- **Adapters for every external service.** Mail, file storage, push, error reporting and public records sit
  behind interfaces with a local/mock implementation, so no credential blocks the build.
- **Time zone:** `America/New_York` for every "today", due date, digest and schedule.

## Stack (versions current at 2026-09)

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router, TypeScript, Turbopack), React 19, installable PWA |
| API | tRPC 11 + TanStack Query 5, superjson, zod 4 |
| Auth | Better Auth 1.7: email/password (invite-only, sign-up disabled), reset, TOTP 2FA, passkeys |
| DB | Postgres via Drizzle ORM + drizzle-kit migrations. Neon Free in prod, local Postgres 16 in dev/CI |
| Files | Cloudflare R2 (S3-compatible presigned URLs), local-disk adapter in dev |
| Email | Resend (HTTP API), outbox table + console adapter in dev |
| Jobs | GitHub Actions cron → authenticated `POST /api/jobs/<name>` (seconds of runner time each). Backups run `pg_dump` in Actions → R2 |
| Errors | `error_log` table + daily owner summary (Sentry only if its terms allow business use; adapter ready) |
| Styling | Tailwind CSS 4 mapped onto design tokens in `src/styles/tokens.css`; hand-built component kit (no templated UI kit) |
| Tests | Vitest (unit + DB integration against real Postgres), Playwright (Chromium desktop + WebKit iPhone profile) |

### Hosting decision (asked before first deploy)

- Vercel **Pro** team exists → host there.
- Otherwise (Hobby is non-commercial) → Cloudflare Workers Free via `@opennextjs/cloudflare`.
  **Known risk:** Workers Free allows 10 ms CPU per request and a 3 MiB compressed script. Password hashing and
  heavy SSR can exceed that. Mitigations: keep pages light, verify bundle size at deploy, and measure CPU on the
  preview. If the limit is breached in practice, I stop and report the cost/alternative per Section 0.1.

## Code layout

```
src/
  app/                 Next.js routes (App Router)
    (auth)/            login, forgot/reset password, invite acceptance
    (app)/             signed-in shell: portfolio, my tasks, projects, team, settings, system, audit
    api/auth/[...all]  Better Auth handler
    api/trpc/[trpc]    tRPC handler
    api/jobs/[job]     scheduled-job endpoints (Bearer JOB_SECRET)
  core/                pure logic, 100% unit tested
  server/
    db/                drizzle client + schema + migrations
    auth.ts            Better Auth instance
    trpc/              context, procedures, permission middleware, routers
    services/          audit log, mailer, usage meter, error log
  components/ui/       component kit built on tokens
  styles/tokens.css    design tokens (light + dark)
tests/
  integration/         router tests against Postgres, permission matrix
  e2e/                 Playwright
.github/workflows/     ci.yml, jobs-*.yml (cron), backup.yml
```

## Data model (grows per milestone)

- **Auth (Better Auth):** `user` (+ `role`, `status`, `twoFactorEnabled`), `session`, `account`, `verification`,
  `two_factor`, `passkey`, `rate_limit`.
- **M1:** `invitation`, `audit_log` (hash-chained, UPDATE/DELETE blocked by trigger), `error_log`, `email_outbox`,
  `job_run`, `company_settings`, `project` (minimal) and `project_member` (project role, `canViewFinancials`,
  `canEditChecklist`, `canApprove`).
- **M2:** project facts, photos, key dates.
- **M3:** `template`, `template_phase`, `task_template`, `toggle`, `project_phase`, `project_toggle`.
- **M4:** `task`, `task_dependency`, `task_comment`, `task_watcher`, `approval`, `recurrence`.
- **M5:** `folder`, `file`, `file_version`, `folder_share`.
- **M6:** `budget_line`, `commitment`, `invoice`, `change_order`, `draw`, `unit_sale`.
- **M7:** `notification`, `push_subscription`, `notification_pref`, `nudge_log`.
- **M8:** `record_snapshot`, `record_alert`, `sync_run`.

## Permission model

`src/core/permissions.ts` holds a pure `can(actor, action, resource)` evaluated by the tRPC middleware:

| Role | Access |
|---|---|
| owner | everything, including users, templates, company settings, audit, system, exports |
| admin | everything on assigned projects; can create projects and edit templates |
| member | assigned projects; works tasks; edits checklist only with `canEditChecklist` |
| external | assigned projects; only tasks assigned or shared; only shared folders; financials only when granted |

Financial fields are removed server-side by a single `redactFinancials()` applied to every payload that
leaves the server (tRPC, search, digests, push, exports). The permission-matrix test runs every procedure ×
role × `canViewFinancials` × assigned/unassigned.

## Milestones

1. **Foundation:** repo, CI, DB + migrations, auth + invites + 2FA + passkeys, roles, audit log, design tokens +
   component kit, app shell, error logging, System page, deploy.
2. **Projects & Portfolio:** create/edit project, hero photos, cards/table/timeline/map, project page shell.
3. **Templates, phases, checklists, toggles:** template studio, full seed library (§5.4), toggle add/remove, save-as-template, template update diff.
4. **Tasks:** statuses, dependencies, approvals, recurrence, comments/@mentions, My Tasks, Needs You rail, key dates, bulk actions.
5. **Files:** R2, folders, versions, previews, task attachments, gated Financial folder.
6. **Financials:** headline, budget, commitments, invoices, change orders, draws, sales tracker, Excel export.
7. **Notifications:** in-app, web push, email with budget guard, daily digest, 2-day nudges, WhatsApp share, preferences, quiet hours.
8. **Public records watch:** Socrata sync per BBL, snapshots/diffs, alerts, "create task from this".
9. **iPhone home-screen app:** service worker, offline cache + queued mutations, camera capture, install guide.
10. **Reports, search, polish, launch:** weekly owner report + PDF, ⌘K search, full pressure test (§13), cut-over, README + team guide.

## Free-tier budget (verified again against pricing pages at each integration milestone)

| Service | Free limit used for alerts | Our design target |
|---|---|---|
| Neon Free | 0.5 GB storage / project, compute-hours cap | < 100 MB structured data |
| Cloudflare R2 | 10 GB storage, 1M Class A / 10M Class B ops per month | photos compressed client-side (2560px, ~80%) |
| Resend Free | 100 emails/day, 3,000/month | digest-first; hold non-urgent mail above 80/day |
| GitHub Actions (private) | 2,000 min/month | jobs call HTTP endpoints; ~1 min per run |
| Cloudflare Workers Free | 100k requests/day, 10 ms CPU | small team → far below |
