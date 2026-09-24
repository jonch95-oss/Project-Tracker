# Public records watch: verified datasets

Brief §10 asks for every dataset id and field name to be checked against live Socrata metadata before coding.

- **When and how:** checked on 2026-09-24 through the `Records probe` workflow (`.github/workflows/records-probe.yml`). It runs on GitHub's runners whenever `.github/records-probe.txt` changes, and prints live metadata and sample rows.
- **Ongoing check:** the sync re-checks each source's required columns on every run. If a dataset changes, the sync fails loudly: the source is marked failed, it retries with backoff, and admins are told on the System page and in their Inbox.

| Source | Dataset | Lookup (as the data is written) | Notes |
|---|---|---|---|
| DOB NOW job filings | `w9ak-ipjd` | `bbl='3011370045'` | Borough is written `Brooklyn` (title case); the `bbl` column is reliable |
| DOB BIS jobs | `ic3t-wcy2` | `house__` + `upper(street_name)` + `borough='BROOKLYN'` | The `bbl` column holds BINs; dates are `MM/DD/YYYY` |
| DOB permits (BIS) | `ipu4-2q9a` | `borough='BROOKLYN'`, block 5 digits, lot 5 digits | `permit_si_no` is the key |
| DOB NOW permits | `rbx6-tga4` | `bbl` | Key is `work_permit` + `sequence_number` (renewals) |
| DOB violations | `3h2n-5cm9` | `boro='3'`, block 5, lot 5 | Open when the category contains `ACTIVE` |
| ECB violations | `6bgk-3dad` | `boro='3'`, block 5, **lot 4** | Status `ACTIVE` / `RESOLVE`; `hearing_date` is `YYYYMMDD` |
| DOB safety violations | `855j-jady` | `bbl` | |
| HPD violations | `wvxf-dwi5` | `bbl` | `violationstatus` `Open` / `Close` |
| HPD vacate orders | `tb8q-a3ar` | `bbl` | In force until `actual_rescind_date` is set (critical) |
| FDNY vacate list | `n5xc-7jfa` | `bbl` | Critical unless the description says dismissed or rescinded |
| DOB complaints | `eabe-havv` | `bin in (…)` or house number + street | No block/lot columns. Stop-work and vacate orders are the disposition codes from `6v9u-ndjg` (see below) |
| OATH hearings | `jz4z-kudi` | borough name, block 5, lot 4 | |
| 311 | `erm2-nwe9` | `bbl`, last two years | |
| Tax lien sale list | `9rz4-mjek` | `borough='3'`, block and lot unpadded | |
| DOF property charges | `scjx-j6np` | `parid` = BBL, `sum_bal > 0` | Rolled up into one "past due" record |
| ACRIS legals → master | `8h5j-fqxa` → `bnx9-e6tj` | legals by `borough='3'` with block and lot unpadded, then master by `document_id` | The Open Data extract lags live ACRIS by 1–2 months; the tab shows "data as of" |

Complaint disposition codes (`6v9u-ndjg`):

| Codes | Meaning | Critical? |
|---|---|---|
| A3 | full stop-work order | yes |
| L1 | partial stop-work order | yes |
| H5 | stop all work | yes |
| K4 | crane stop-work order | yes |
| Y1, ME, MH | full vacate order | yes |
| Y3, MF, MI | partial vacate order | yes |
| L2 | stop-work order fully rescinded | no |
| Y2 | vacate order fully rescinded | no |
| L3 | stop-work order partly rescinded | no |
| Y4 | vacate order partly rescinded | no |

The rescission codes don't raise a critical alert, and none of them keeps a critical order in force.
