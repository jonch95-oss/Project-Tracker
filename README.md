# Project Command

Private development-project tracker for Ariel Development Group and Lian Development JV Group. It is one responsive web app that also installs on iPhone as a Home Screen app.

- **Owner:** "Where am I on every project, and what is stuck?"
- **Team member:** "What exactly do I have to do today?"

See `PLAN.md` for the architecture and milestones, and `PROGRESS.md` for what has shipped.

## Stack

Next.js 16 (App Router) · tRPC 11 · Better Auth (invite-only, 2FA, passkeys) · Drizzle + Postgres (Neon Free) · Vercel Pro (hosting, Blob, Cron) · Resend Free · GitHub Actions for CI and the nightly backup. There is **no added monthly cost**. The owner-only System page shows live usage against every limit.

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

1. **Vercel project** `project-tracker` (team "jonch95-oss' projects"):
   - Connect the Neon database under Storage. This sets `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.
   - Connect a **private** Blob store. This sets `BLOB_READ_WRITE_TOKEN`.
   - Set `BETTER_AUTH_SECRET`, `CRON_SECRET`, `APP_URL` (`https://projects.liandev.com` once DNS is live), `EMAIL_FROM` and, once Resend is set up, `RESEND_API_KEY`.
2. **GitHub repository secrets**, for the backup workflow: `DATABASE_URL_UNPOOLED`, `BLOB_READ_WRITE_TOKEN`, `APP_URL`, `CRON_SECRET`.
3. **Migrate:** `DATABASE_URL=<unpooled url> npm run db:migrate`. The production database starts empty; never run the demo seed on it.
4. **First owner:** `DATABASE_URL=… APP_URL=https://projects.liandev.com npm run bootstrap:owner -- --email you@liandev.com --name "Jon"`. Open the printed link. Invite everyone else from **Team**.
5. **Spend management:** in Vercel → Team Settings → Billing → Spend Management, set a cap and turn on "pause production deployments" at the cap. In GitHub → Billing, keep the Actions budget at $0 with "stop usage".
6. **Restore drill:** see `docs/RESTORE.md`.
