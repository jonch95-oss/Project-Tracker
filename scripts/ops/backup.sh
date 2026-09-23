#!/usr/bin/env bash
# Nightly logical backup of the production database to Cloudflare R2.
set -euo pipefail
: "${DATABASE_URL:?}" "${R2_ACCOUNT_ID:?}" "${R2_BACKUP_BUCKET:?}"
endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
file="/tmp/project-command-${stamp}.dump"
key="backups/project-command-${stamp}.dump"

# Custom format is compressed and restores selectively with pg_restore.
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$file" "$DATABASE_URL"
size=$(stat -c %s "$file")
pg_restore --list "$file" > /dev/null   # sanity check: the archive is readable

aws s3 cp "$file" "s3://${R2_BACKUP_BUCKET}/${key}" --endpoint-url "$endpoint" --only-show-errors
echo "Uploaded ${key} (${size} bytes)"

# Keep the newest 30 dumps.
aws s3 ls "s3://${R2_BACKUP_BUCKET}/backups/" --endpoint-url "$endpoint" | awk '{print $4}' | sort | head -n -30 | while read -r old; do
  [ -n "$old" ] && aws s3 rm "s3://${R2_BACKUP_BUCKET}/backups/${old}" --endpoint-url "$endpoint" --only-show-errors && echo "Pruned ${old}"
done

if [ -n "${APP_URL:-}" ] && [ -n "${JOB_SECRET:-}" ]; then
  curl -sS --fail --max-time 60 -X POST -H "Authorization: Bearer ${JOB_SECRET}" -H "content-type: application/json" \
    -d "{\"objectKey\":\"${key}\",\"sizeBytes\":${size},\"kind\":\"nightly\"}" "${APP_URL}/api/jobs/record-backup"
fi
