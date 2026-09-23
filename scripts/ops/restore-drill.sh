#!/usr/bin/env bash
# Restore drill: fetch the newest dump from Vercel Blob (or use a local file),
# restore it into a scratch database and prove it is intact.
# Usage: scripts/ops/restore-drill.sh <dump-file|--latest-from-blob> <admin-postgres-url>
#   admin url e.g. postgres://postgres:postgres@localhost:5432/postgres
set -euo pipefail
dump="$1"; admin="$2"
if [ "$dump" = "--latest-from-blob" ]; then
  dump="$(mktemp -d)/latest.dump"
  node "$(dirname "$0")/blob-backup.mjs" latest "$dump"
fi
target="pc_restore_drill_$(date +%s)"
target_url="${admin%/*}/${target}"
psql "$admin" -qc "create database ${target}"
pg_restore --no-owner --no-privileges --dbname="$target_url" "$dump"
echo "Restored into ${target}. Row counts:"
psql "$target_url" -Atc "select 'users', count(*) from \"user\" union all select 'projects', count(*) from project union all select 'audit_log', count(*) from audit_log union all select 'migrations', count(*) from drizzle.__drizzle_migrations"
# The audit trigger must survive the restore.
if psql "$target_url" -qc "update audit_log set summary = summary" 2>/dev/null; then
  echo "FAIL: audit_log accepted an UPDATE after restore"; exit 1
fi
echo "Audit log is still append-only after restore."
echo "Verify the hash chain by pointing the app at ${target_url} and using Audit log → Verify integrity, or run:"
echo "  DATABASE_URL=${target_url} npx tsx --conditions=react-server scripts/verify-audit.ts"
