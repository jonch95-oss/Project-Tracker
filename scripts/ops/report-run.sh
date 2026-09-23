#!/usr/bin/env bash
# Report this job's runtime so the System page can track the 2,000 free
# Actions minutes. Needs RUN_START (set by the workflow's first step).
# Never fails the workflow.
set -uo pipefail
workflow="$1"; status_in="${2:-success}"
if [ -z "${APP_URL:-}" ] || [ -z "${CRON_SECRET:-}" ]; then echo "Reporting skipped (secrets not set)"; exit 0; fi
now=$(date +%s)
# +30s approximates runner setup before the first step.
duration=$(( now - ${RUN_START:-$now} + 30 ))
status=$([ "$status_in" = "success" ] && echo succeeded || echo failed)
curl -sS --fail-with-body --max-time 30 -X POST -H "Authorization: Bearer ${CRON_SECRET}" -H "content-type: application/json" \
  -d "{\"workflow\":\"${workflow}\",\"durationSeconds\":${duration},\"status\":\"${status}\"}" \
  "${APP_URL%/}/api/jobs/report-run" || echo "Reporting failed (not fatal)"
echo
