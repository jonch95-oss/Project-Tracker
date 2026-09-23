# Project Command

Private development-project tracker for Ariel Development Group and Lian Development JV Group. It is one responsive web app that also installs on iPhone as a Home Screen app.

- **Owner:** "Where am I on every project, and what is stuck?"
- **Team member:** "What exactly do I have to do today?"

See `PLAN.md` for the architecture and milestones, and `PROGRESS.md` for what has shipped.

## Stack

Next.js 16 (App Router) · tRPC 11 · Better Auth (invite-only, 2FA, passkeys) · Drizzle + Postgres (Neon Free) · Vercel Pro (hosting, Blob, Cron) · GitHub Actions for CI and the nightly backup. Email is on hold behind an interface. There is **no added monthly cost**. The owner-only System page shows live usage against every limit.

## Develop

```bash
cp .env.example .env.local        # fill BETTER_AUTH_SECRET (openssl rand -base64 48) and CRON_SECRET
createdb pc_dev                   # any local Postgres 16+
npm install
npm run db:migrate
npm run seed:demo                 # demo data only (refuses non dev/test/demo databases)
npm run dev
```

Demo users (demo seed only): `jon@demo.test` (owner), `elias@demo.test` (admin), `ariel@demo.test` (member), `architect@demo.test` (outside collaborator). The password is `demo password 1`.

## Test

```bash
npm run lint && npm run typecheck
npm test                  # unit tests for src/core
npm run test:coverage     # with 95% coverage thresholds
npm run test:integration  # real Postgres: permission matrix, auth, invites, audit, jobs
npm run test:e2e          # Playwright; set E2E_WEBKIT=1 for the iPhone WebKit profile
```

## Code layout

- `src/core`: pure business logic (permissions, money, time, free-tier math, audit hashing). No I/O; fully unit tested.
- `src/server`: database, Better Auth, tRPC routers with permission middleware, services (audit, email, usage, jobs).
- `src/app`: routes. `(auth)` holds sign-in, reset and invites; `(app)` holds the signed-in shell.
- `src/components/ui`: the component kit, built on `src/styles/tokens.css`.
- `drizzle/`: SQL migrations, including the audit-log protection triggers.
- `scripts/`: migrate, bootstrap the first owner, the demo seed, and ops scripts (backup, restore drill).

## Production setup (first time)

Production is **https://ariel-dev-projects.vercel.app** (Vercel project `project-tracker`, team "jonch95-oss' projects"). There is no custom domain.

1. **Vercel environment variables:**
   - Neon (Storage integration) provides `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.
   - `APP_URL=https://ariel-dev-projects.vercel.app` for **Production only**. Previews derive their own URL. Production redirects any other host to this one, so passkeys and links always match.
   - `BETTER_AUTH_SECRET`, `CRON_SECRET` (Vercel Cron), `SETUP_KEY` (one-time owner setup), `SOCRATA_APP_TOKEN`.
   - Connect a **private** Blob store for app files (`project-tracker-files`). It adds `BLOB_READ_WRITE_TOKEN`.
   - Email is **on hold**. Leave `RESEND_API_KEY` unset; invites and resets are shared as on-screen links.
2. **Migrations** run automatically on every production build (`scripts/vercel-build.mjs`), serialized with an advisory lock. Keep migrations **additive** (expand, then contract in a later release): the old deployment may run briefly against the new schema, and Instant Rollback must keep working.
3. **First owner:** open `/setup` on the production URL and enter your name, email and the `SETUP_KEY`. The page works once, while the database is empty. Invite everyone else from **Team**.
4. **Backups:** create a **second** private Blob store (`project-tracker-backups`) and don't connect it to the project. Add these GitHub repository secrets:
   - `DATABASE_URL_UNPOOLED`
   - `BACKUP_BLOB_READ_WRITE_TOKEN`: the backup store's token
   - `BACKUP_PASSPHRASE`: long and random; keep a copy offline, because without it dumps can't be restored
   - `APP_URL`
   - `CRON_SECRET`
5. **Spend management:** in Vercel → Team Settings → Billing → Spend Management, set a cap and pause production at the cap. In GitHub → Billing, keep the Actions budget at $0 with "stop usage".
6. **Restore drill:** GitHub → Actions → "Restore drill" → Run (see `docs/RESTORE.md`).
