# Backups and restore

## What is backed up

- **Database:** `.github/workflows/backup.yml` runs nightly (~3–4am New York). It runs `pg_dump` (custom format, compressed) against the production database, checks the archive with `pg_restore --list`, uploads it to the R2 bucket under `backups/`, keeps the newest 30 dumps and reports the backup to the System page.
- Neon's free plan keeps only a 6-hour restore window, so these dumps are the real backups.
- **Files (M5+):** stored in R2. Keep versioning on in the app; a bucket-to-bucket copy is not needed at this size.

## Restore drill (do it before launch, then quarterly)

1. Download the newest dump:
   `aws s3 cp s3://$R2_BACKUP_BUCKET/backups/<file>.dump . --endpoint-url https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com`
2. Restore it into a scratch database and run the checks:
   `scripts/ops/restore-drill.sh <file>.dump postgres://USER:PASS@HOST/postgres`
   The script creates `pc_restore_drill_<ts>`, restores into it, prints row counts, and confirms the audit log still rejects UPDATE.
3. Verify the audit hash chain:
   `DATABASE_URL=<drill db url> npx tsx --conditions=react-server scripts/verify-audit.ts`
4. Drop the drill database.

### Drill log

| Date | Source | Result |
|---|---|---|
| 2026-09-23 | Local dev database (M1). Neon and R2 were not connected yet | Restored 4 users, 3 projects, 2 audit entries, 2 migrations. Audit trigger intact after restore. Hash chain verified |

## Full production restore

1. In Neon, create a new branch or project (free) and copy its direct connection string.
2. Run `pg_restore --no-owner --no-privileges --dbname=<new url> <dump>`.
3. Point `DATABASE_URL` at the new database and redeploy.
4. Run `scripts/verify-audit.ts` against it. Then sign in and check the System page.
