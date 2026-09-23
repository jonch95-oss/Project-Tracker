#!/usr/bin/env bash
# Call a job endpoint with retries and backoff. Fails loudly (non-zero exit) so
# the workflow shows red and GitHub emails the repo owner.
set -euo pipefail
job="$1"
: "${APP_URL:?APP_URL secret is not set}"
: "${JOB_SECRET:?JOB_SECRET secret is not set}"
for attempt in 1 2 3 4; do
  # Neon scales to zero; the first request after idle can be slow.
  code=$(curl -sS -o /tmp/job.out -w '%{http_code}' --max-time 120 -X POST \
    -H "Authorization: Bearer ${JOB_SECRET}" -H "x-job-trigger: schedule" "${APP_URL}/api/jobs/${job}" || echo 000)
  cat /tmp/job.out; echo
  if [ "$code" = "200" ]; then exit 0; fi
  if [ "$code" = "401" ] || [ "$code" = "404" ]; then echo "Job ${job} rejected (${code})"; exit 1; fi
  sleep $((2 ** attempt * 2))
done
echo "Job ${job} failed after retries"
exit 1
