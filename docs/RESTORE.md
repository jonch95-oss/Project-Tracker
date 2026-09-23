# Backups and restore

## What is backed up

- **Database:** `.github/workflows/backup.yml` runs nightly (~3–4am New York). Each run:
  1. Records an **anchor**: the audit log's latest `seq` and `hash`, stored under `anchors/`.
  2. Runs `pg_dump` (custom format, compressed) and checks the archive with `pg_restore --list`.
  3. Encrypts the dump with **AES-256** (`gpg`, passphrase `BACKUP_PASSPHRASE`).
  4. Uploads it to a **dedicated private Vercel Blob store** under `backups/`. The app has no token for that store.
  5. Keeps the newest 30 dumps and reports the backup to the System page.
- **Anchors** are never pruned. A drill checks that the restored audit log still contains the latest anchored entry, which catches entries cut from the end of the log.
- Neon's free plan keeps only a 6-hour restore window, so these dumps are the real backups.
- **Files (M5+):** stored in the same private Blob store. The app keeps every version.

## Restore drill (do it before launch, then quarterly)

**Easiest:** GitHub → Actions → "Restore drill" → Run workflow (or change `ops/triggers/restore-drill` on main). It downloads the newest dump from Vercel Blob, restores it into a throwaway Postgres 18, confirms the audit log is still append-only, verifies the hash chain, and records the drill on the System page.

Manual alternative:

1. Fetch, decrypt and restore the newest dump into a scratch database:
   `BLOB_READ_WRITE_TOKEN=<backup store token> BACKUP_PASSPHRASE=… scripts/ops/restore-drill.sh --latest-from-blob postgres://USER:PASS@HOST/postgres`
   (or pass a local `.dump` / `.dump.gpg` file instead of `--latest-from-blob`)
   The script creates `pc_restore_drill_<ts>`, restores into it, prints row counts, and confirms the audit log still rejects UPDATE.
2. Verify the audit hash chain against the latest anchor:
   `DATABASE_URL=<drill db url> npx tsx --conditions=react-server scripts/verify-audit.ts --anchor "<seq> <hash>"`
3. Drop the drill database.

### Drill log

| Date | Source | Result |
|---|---|---|
| 2026-09-23 | Local dev database (M1), unencrypted file | Superseded |
| 2026-09-23 | Local dev database, **encrypted** dump (AES-256), local file | Decrypted and restored: 4 users, 3 projects, 5 audit entries, 3 migrations. Triggers present. Chain verified. Anchor #5 matched. A simulated truncated log was rejected |
| 2026-09-23 | **Production** Neon (Postgres 18) → nightly workflow → encrypted dump in the `project-tracker-backups` Blob store (12.9 KB) → GitHub "Restore drill" workflow ([run](https://github.com/jonch95-oss/Project-Tracker/actions/runs/35930377459)) | Decrypted and restored into a throwaway Postgres 18: 1 user, 0 projects, 3 audit entries, 3 migrations. Audit-log triggers intact after restore. Hash chain verified; anchor #3 from the backup store matched. Drill recorded on the System page |

## Full production restore

1. In Neon, create a new branch or project (free) and copy its direct connection string.
2. Run `pg_restore --no-owner --no-privileges --dbname=<new url> <dump>`.
3. Point `DATABASE_URL` at the new database and redeploy.
4. Run `scripts/verify-audit.ts` against it. Then sign in and check the System page.
