#!/usr/bin/env bash
# Restore drill: fetch the newest dump from Vercel Blob (or use a local file),
# restore it into a scratch database and prove it is intact.
# Usage: scripts/ops/restore-drill.sh <dump-file|--latest-from-blob> <admin-postgres-url>
#   admin url e.g. postgres://postgres:postgres@localhost:5432/postgres
set -euo pipefail
dump="$1"; admin="$2"
if [ "$dump" = "--latest-from-blob" ]; then
  dump="$(mktemp -d)/latest.dump.gpg"
  node "$(dirname "$0")/blob-backup.mjs" latest "$dump"
fi
if [[ "$dump" == *.gpg ]]; then
  : "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required to decrypt the dump}"
  gpg --batch --yes --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" -o "${dump%.gpg}" --decrypt "$dump"
  dump="${dump%.gpg}"
fi
target="pc_restore_drill_$(date +%s)"
target_url="${admin%/*}/${target}"
psql "$admin" -qc "create database ${target}"
pg_restore --no-owner --no-privileges --dbname="$target_url" "$dump"
echo "Restored into ${target}. Row counts:"
psql "$target_url" -Atc "select 'users', count(*) from \"user\" union all select 'projects', count(*) from project union all select 'audit_log', count(*) from audit_log union all select 'migrations', count(*) from drizzle.__drizzle_migrations"
# The append-only triggers must survive the restore (checked directly, since
# an UPDATE on an empty table would not fire a row trigger).
triggers=$(psql "$target_url" -Atc "select count(*) from pg_trigger where tgname in ('audit_log_no_update','audit_log_no_truncate') and not tgisinternal")
if [ "$triggers" != "2" ]; then
  echo "FAIL: audit_log protection triggers missing after restore (found ${triggers})"; exit 1
fi
echo "Audit log is still append-only after restore."
echo "Verify the hash chain by pointing the app at ${target_url} and using Audit log → Verify integrity, or run:"
echo "  DATABASE_URL=${target_url} npx tsx --conditions=react-server scripts/verify-audit.ts"
