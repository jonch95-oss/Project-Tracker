# Workflow triggers

Changing a file here on `main` starts the matching GitHub Actions workflow
(useful when "Run workflow" isn't available, e.g. from a phone or an integration):

- `backup`: nightly encrypted backup to the backup Blob store
- `restore-drill`: restore the newest backup into a throwaway Postgres and verify it

Put a date and reason on one line, for example `2026-09-23 first production backup`.
