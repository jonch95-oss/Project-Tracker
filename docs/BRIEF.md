# BUILD BRIEF — Ariel Development "Project Command"
### A development project tracker for a Brooklyn real estate developer. Paste this whole brief into Claude Code in an empty folder.

> Source of truth. Updated by Change Order 01 (2026-09-23): Vercel Pro hosting, Vercel Blob storage, Vercel Cron, no Cloudflare; Section 14A modules A–N (Module A is BBL auto-fill only — never connect to the deal platform); 13 milestones.

---

## 0. How you will work

You are building a finished, production-grade product, not an MVP. There is no v1 or v2. Build it in the 13 milestones in Section 15, **one at a time**. Each milestone must be fully built, tested, deployed to a preview URL and signed off against its Definition of Done before you start the next one.

- Every decision in this brief is final. **Do not ask me questions that this brief answers.** Ask me only for credentials and accounts (Section 16) or for a genuine contradiction.
- Start in plan mode. Read the whole brief, write `PLAN.md`, then execute.
- Keep `PROGRESS.md` updated after every milestone with:
  - what shipped
  - test results
  - the preview URL
  - any known limitations
- Use the latest stable versions of everything. Check current docs before you write integration code rather than relying on memory.
- At the end of each milestone, spawn a separate review subagent that has not seen the code being written. Have it attack the milestone for:
  - bugs
  - permission leaks
  - UX friction
  - visual inconsistency

  Fix everything it finds before moving on.

### 0.1 Cost rule — overrides everything else in this brief

**No added monthly cost.** We already pay for **Vercel Pro**, so using what that plan includes is allowed. Every other service must be on a permanent free tier that allows business use.

- **No paid services.** That means:
  - no Twilio, no SMS, no WhatsApp API
  - no Apple Developer Program
  - no paid job runner
  - no paid monitoring
- **Stay inside the free-tier limits.** Design every feature to stay well inside them. At startup, and on an owner-only "System" page, show live usage against each service's free-tier limit and against Vercel Pro's included usage.
- **Warn before any charge.** Alert me by email when any service passes 70% of a free limit or of Vercel Pro's included usage. Set a Vercel spend cap so overage can never bill silently. Nothing may ever auto-upgrade to a paid plan.
- **Check the limits first.** Before you choose a service, verify its current free-tier limits and commercial-use terms on its own pricing and terms pages. If a free tier forbids business use, do not use it.
- **If something truly cannot be done for free:** stop, tell me the monthly cost, and offer the free alternative. Never add a paid service silently.

---

## 1. The product in one paragraph

A private web app, installable on iPhone as a home-screen app, for Ariel Development / Lian Development. It must answer two questions in under 10 seconds:

1. **Owner:** "Where am I on every project, and what is stuck?"
2. **Team member:** "What exactly do I have to do today?"

Every project moves through phases. Each phase carries a checklist built from a template. Toggles add or remove whole groups of tasks based on the site's conditions, such as landmarked, occupied, E-designation or foreclosure buy. Tasks have owners, due dates, dependencies and approvals. The system chases people automatically until the work is done. It also watches NYC public records for each property and alerts the team when something changes.

It must feel like a private bank or a top architecture firm's intranet, not a SaaS dashboard.

---

## 2. Decisions already made

| Topic | Decision |
|---|---|
| Users | Internal team plus outside parties with limited access: architect, expediter, GC, lender, JV partner |
| Initial users | Jon (owner), Elias, Ariel. Jon adds the others from inside the app |
| Visibility | Per-project assignment, plus a separate per-user, per-project **financial visibility** flag |
| Branding | Neutral house brand "Project Command". A company field on each project (Ariel Development Group / Lian Development JV Group) shows on reports |
| Platforms | One responsive web app that installs on iPhone as a **Progressive Web App** (home-screen icon, full screen, push notifications, camera, offline). No App Store, so no $99/yr Apple fee |
| Auth | Email and password, invite-only, password reset, optional TOTP 2FA, plus **passkeys** so iPhone users unlock with Face ID |
| Project types | Ground-up condo · Gut renovation / townhouse conversion · Contract flip · Foreclosure auction buy · Condo conversion |
| Phases | Editable, with a default set in Section 5 |
| Checklists | Invented starter library (Section 5). Fully editable: add, remove, reorder and rename; save any project as a new template |
| Project card | All of: address, BBL, photo, phase, % complete, next action + owner, days in phase, blockers, key dates, price, budget vs actual, projected sellout |
| Financials | Headline numbers **and** full cost tracking: budget lines, commitments, invoices, draws, change orders |
| Notifications | In-app, iPhone and desktop web push, email, daily digest. **No SMS or WhatsApp API** (both cost money); a free WhatsApp share button instead. Overdue tasks re-nudge the owner **every 2 days** until done |
| Dependencies | Yes, set only where relevant |
| Approvals | Yes. Tasks can require sign-off from a named approver |
| Files | Built-in storage |
| Public records | Nightly sync per BBL, with notifications on change |
| Design | Architectural: warm neutrals and large project photography (Section 11) |
| Seed data | No real projects. Ship an empty production database. Keep a separate demo seed for testing only |

---

## 3. Stack

Every piece below is free. Verify each free tier against its own pricing page before building (Section 0.1).

**App and code**
- **Single app:** Next.js (App Router, TypeScript), built as an installable PWA
  - manifest and service worker
  - offline cache
  - Web Push using VAPID keys, which is free and built into browsers
- **Code layout:**
  - `src/core`: pure business logic (templates, toggles, dependencies, money math), fully unit-tested
  - `src/server`: tRPC routers with the permission middleware
- **Auth:** Better Auth, self-hosted inside the app at no cost
  - email/password, invites, reset
  - TOTP 2FA
  - passkeys (Face ID / Touch ID)

**Services**
- **Database:** Neon Postgres, Free plan, via Drizzle ORM
  - The free plan has a 0.5 GB storage cap per project. Files never go in the database, so structured data will fit for years.
  - The free plan scales to zero, so allow for a cold start on the first query.
- **File storage:** Vercel Blob, on our Vercel Pro team
  - Use client-side direct uploads with signed tokens, and private access for every file.
  - Check Vercel Pro's current included Blob storage and transfer before building, and stay inside it.
  - Compress photos on the device before upload: long edge 2560px, WebP/JPEG around 80%.
  - Show storage used against the included amount on the System page.
- **Email:** Resend, Free plan, sending from `projects@liandev.com` (or whatever domain I give you)
  - The free plan caps sending at 100 emails a day, and every recipient counts.
  - Treat push and in-app as the primary channels. Email carries only the daily digest, invites, password resets, approvals and the third overdue nudge.
  - Never send one email per event. Batch everything into the digest.
- **Scheduled jobs:** Vercel Cron, included in Pro. It runs:
  - nudges (hourly)
  - the daily digest
  - the weekly report
  - public-records sync
  - expiry checks

  Split long jobs into batches so each run stays inside the function time limit. Log every run on the System page.
- **Backups:** nightly `pg_dump` from a GitHub Actions workflow (free for a private repo) to Vercel Blob, keeping 30 daily dumps.
  - Neon's free plan keeps only a short restore window, so this dump is the real backup.
  - Do a restore drill before launch.
- **Error monitoring:** Sentry free plan if its terms allow business use. If they don't, log errors to a table and send a daily error summary to the owner.

**Hosting**
- **Vercel Pro**, which we already pay for. Deploy as a new project on the existing Pro team. It is a separate project with its own database; it shares nothing with my other apps.
- Do not use Cloudflare for anything.

**Time zone:** America/New_York everywhere (due dates, digests, "today").

---

## 4. Users, roles and permissions

**Roles:**

| Role | Access |
|---|---|
| **Owner** | Everything. Manages users, templates and company settings |
| **Admin** | Everything on assigned projects. Can create projects and edit templates |
| **Member** | Sees assigned projects. Works tasks. Edits checklists only if granted per project |
| **External** (architect, expediter, GC, lender, JV partner) | Sees only assigned projects. Sees only tasks assigned to them, or tasks explicitly shared with them. Sees only folders shared with them. Never sees financials unless explicitly granted |

**Per project membership** carries:

- a project role (for example PM, Acquisitions, Construction, Legal, Sales)
- `canViewFinancials`
- `canEditChecklist`
- `canApprove`

**Server-side enforcement is mandatory:**

- Every tRPC procedure checks membership and flags.
- Financial data must never leak through search, notifications, digests, exports, activity feeds, file listings or push text.
- Row-level checks belong in `src/server` middleware, and they must be tested (Section 13).

**Audit log:** an immutable log of every create, update, delete, approval, permission change, login and export. Owner-visible.

---

## 5. Templates, phases, checklists and toggles — the heart of the product

### 5.1 Model

- A **Template** is a project type, an ordered list of **Phases**, and **Task Templates** inside each phase.
- Each task template has:
  - title and description
  - default role
  - relative due date (days from phase start or from another task)
  - `requiresApproval` and an approver role
  - dependencies
  - optional sub-checklist items
  - optional required attachment (for example "upload the survey PDF")
  - **toggle conditions**: show only if a toggle is on, or hide if a toggle is on
- A **Toggle** is a named project condition. Turning a toggle on inserts its tasks into the right phases. Turning it off removes its **not-started** tasks and asks before removing started ones.
- A new project is created by:
  1. choosing a type
  2. answering the toggle questions ("Is it landmarked? Occupied? Excavation? Construction loan?")
  3. generating the checklist
- After that, everything is editable per project: add, delete, reorder, rename, reassign and re-date.
- "Save as template" turns any live project's structure into a new template.
- Template changes do **not** silently rewrite live projects. Offer "apply template update to projects X, Y" with a diff preview.
- Phases per project can be skipped, renamed or added.

### 5.2 Default phases

Pipeline → Under Contract → Due Diligence → Closing → Design & Zoning → DOB Filing & Approval → Pre-Construction → Construction → TCO / CO → AG Plan & Sales → Sold Out / Closed

- **Contract flip** uses: Pipeline → Under Contract → Marketing to End Buyers → Assignment → Closed.
- **Foreclosure auction** inserts "Auction" between Pipeline and Closing, and uses the referee's terms of sale in place of a negotiated contract.

### 5.3 Toggles

- Landmarked / historic district (LPC)
- MIH area
- E-designation
- Occupied / rent-stabilized tenants
- Demolition
- Excavation / underpinning / adjoining buildings
- Construction loan
- JV partner / outside equity
- Tax incentive (485-x / 421-a)
- Condo sale exit (AG plan) vs rental hold
- Foreclosure auction purchase
- Contract flip (assignment)
- 1031 exchange
- Flood zone
- Existing violations to clear

### 5.4 Starter checklist library

Write this as seed data. Tags in brackets are toggle conditions. (A) means the task requires approval.

**Pipeline / Screening**
- MIH check [kill screen]
- E-designation check [kill screen]
- LPC landmark / historic district check [kill screen]
- PLUTO pull: zoning, lot dimensions, residential FAR, built FAR, unused ZSF
- ACRIS chain of title and open mortgages
- DOB / ECB / HPD open violations
- Occupancy and rent-stabilization check
- Finished-product sales comps
- Pro forma / residual land value
- Site visit with photos
- Offer / LOI sent
- Partner approval to offer (A)

**Under Contract**
- Contract negotiated by counsel
- Contract signed (A)
- Deposit wired to escrow
- DD expiry and closing dates entered as key dates
- Assignment rights confirmed [contract flip]
- Title ordered
- Buying entity formed, EIN, bank account
- Insurance quotes

**Auction** [foreclosure]
- Terms of sale obtained from the referee / Foreclosure Office
- Title search
- Confirm vacant
- Deposit certified check ready
- Max bid (A)
- Attend the auction
- Memorandum of sale signed
- Closing deadline entered per terms of sale

**Due Diligence**
- Title report reviewed; exceptions cleared
- Survey ordered and reviewed
- Phase I ESA
- Phase II if RECs found
- OER remedial path [E-designation]
- Zoning analysis by architect / zoning counsel with ZR sections cited
- Building condition / structural report [existing building]
- Rent roll, leases, estoppels, DHCR registration history, tenant buyout / relocation plan [occupied]
- Geotech borings [excavation]
- Utility capacity: Con Ed, DEP sewer / water
- FEMA flood zone [flood]
- Violation clearance plan [violations]
- Tax, water and sewer arrears check
- LPC pre-application meeting [landmarked]
- Construction loan term sheets [loan]
- Final budget and pro forma (A)
- Go / no-go decision (A)

**Closing**
- Loan commitment and lender DD [loan]
- Title bill and closing statement reviewed (A)
- Transfer tax / RPT forms
- Builder's risk and GL insurance bound
- Funds wired
- Deed recorded; ACRIS confirmation
- Utilities transferred
- Site secured: fence, signage, lock change
- JV agreement executed [JV]
- 1031 identification and closing deadlines [1031]

**Marketing to End Buyers / Assignment** [contract flip]
- Pricing (A)
- Buyer outreach
- Buyer DD access
- Assignment agreement signed
- Assignment fee received
- Seller consent if required

**Design & Zoning**
- Architect engaged; fee approved (A)
- Schematic design with unit mix and sellable area
- Zoning diagram
- Structural and MEP engineers engaged
- Expediter engaged
- Design development
- High-end finish spec
- Sales broker layout review
- LPC Certificate of Appropriateness [landmarked]
- OER Remedial Action Plan [E-designation]
- Construction documents (A)

**DOB Filing & Approval**
- DOB NOW job filed (NB, or ALT with new CO)
- Special inspections (TR1)
- Energy code (TR8)
- Plan exam objections resolved
- Approval received
- Asbestos investigation and DEP ACP filings [demolition]
- Demolition permit [demolition]
- Support of excavation / underpinning design and adjacent monitoring [excavation]
- Neighbor access / license agreements (RPAPL 881) [excavation]
- Tenant Protection Plan [occupied]
- DEP site connection proposal
- DOT permits: sidewalk shed, curb cut, crane
- Con Ed service application
- Work permits issued and posted

**Pre-Construction**
- GC bids leveled
- GC selected (A)
- GC contract signed (A)
- COIs received
- Construction loan closed [loan]
- Baseline schedule
- Budget locked to contract / GMP (A)
- Pre-construction survey of adjoining buildings [excavation]
- Site safety plan if required
- Sidewalk shed and fence installed

**Construction**
- Recurring tasks:
  - weekly OAC meeting
  - weekly site photos
  - monthly draw (requisition, lender inspector sign-off, lien waivers, retainage) [loan]
  - change order review (A)
- Milestones:
  - demo complete
  - excavation / foundation
  - superstructure topped out
  - watertight envelope
  - MEP rough-in
  - rough inspections
  - drywall
  - finishes
  - elevator [if applicable]
  - punch list
- Controlled inspections logged
- Utility energization

**TCO / CO**
- Final plumbing, electrical, elevator and FDNY inspections
- TR1 / TR8 sign-offs
- TCO issued
- TCO renewal tracker with auto-reminders
- Final CO
- Punch list complete

**AG Plan & Sales** [condo exit]
- Sales broker engaged (A)
- Condo counsel engaged
- Offering plan submitted to the NY AG
- Accepted for filing
- Pricing schedule (A)
- Declaration and bylaws
- DOF tax lot apportionment
- 485-x / 421-a filings [tax incentive]
- Renderings, website, listings
- Per-unit contract tracker
- Plan declared effective
- Unit closings with lender partial releases [loan]

**Rental / Hold** [rental hold]
- Lease-up plan
- Registration filings as required
- Permanent loan refinance

**Sold Out / Closed**
- Final closings
- Lender payoff
- Final accounting
- JV distribution waterfall [JV]
- Transfer to condo board [condo]
- Warranty-period tracker
- Archive project files

Every item carries a sensible default role, a relative due date and dependencies. Examples:

- DOB filing depends on Construction documents.
- GC contract depends on GC selected.
- Closing depends on Title cleared and Go / no-go.

Dependencies block check-off and visibly explain why.

---

## 6. Tasks

- Fields:
  - title and description
  - project and phase
  - assignee (one) and watchers
  - due date
  - priority
  - status: Not started / In progress / Waiting on third party / Blocked / Awaiting approval / Done
  - blocked reason
  - sub-checklist
  - attachments
  - comments with @mentions
  - dependency links
  - approval (approver, decision, note, timestamp)
  - recurrence
- **One-tap complete** on web and mobile. If a required attachment or approval is missing, completing it routes to that step instead.
- "Waiting on third party" captures who (for example "Expediter — DOB plan exam") and follows up automatically.
- Bulk actions: reassign, re-date or shift a whole phase by N days.
- Key dates live on the project and drive reminders:
  - DD expiry
  - closing
  - TOE
  - TCO expiry
  - loan maturity
  - 1031 deadlines
  - auction date

---

## 7. Screens

1. **Portfolio (Owner home)**
   - Large photo cards for each project, showing:
     - address and BBL
     - type
     - company
     - a horizontal phase track showing the current phase
     - % complete
     - next action and owner
     - days in phase
     - blocker and overdue counts
     - next key date
     - headline financials if permitted
   - Views: Cards / Table / Timeline (phase Gantt across all projects) / Map
   - Filters by phase, type, company, person and status
   - A **"Needs you"** rail with:
     - approvals waiting on me
     - blocked tasks
     - overdue tasks by person
     - new public-record alerts
     - key dates in the next 14 days
2. **My Tasks (default home for everyone else)**
   - Sections: Overdue / Today / This week / Later / Waiting on others / Awaiting my approval
   - Grouped by project, with the project photo thumbnail
   - Zero-thinking design: a person opens it and knows exactly what to do
3. **Project page**
   - Hero photo
   - Address, BBL and key facts: lot, zoning, FAR, units, sellable sf
   - Phase stepper; click a phase to see its checklist
   - Tabs: Overview · Checklist · Team · Key Dates · Financials (gated) · Files · Public Records · Activity
   - Toggles panel with a live preview of the tasks each toggle adds or removes
4. **Template studio**
   - Drag-and-drop phases and tasks
   - Toggle rules editor
   - Relative-date editor
   - Dependency editor
   - Preview "generate for a test project"
5. **Team & permissions**
   - Invite users
   - Set roles and per-project flags
   - Deactivate users
   - View a user's workload
6. **Notifications center and preferences**
   - Per channel and per event type
   - Quiet hours
7. **Global search / command bar (⌘K)**
   - Covers projects, tasks, files, people and BBLs
   - Permission-aware
8. **Weekly owner report**
   - Auto-generated every Monday 7:00am
   - Web view, emailed PDF and PDF export: one page per project with phase, progress, what moved, what's stuck, next 2 weeks, and headline financials

---

## 8. Financials (gated by `canViewFinancials`)

- **Headline**
  - Purchase price
  - Total project budget
  - Spent to date
  - Committed
  - Forecast at completion
  - Projected sellout
  - Profit and margin
  - Equity required
  - Simple equity multiple
- **Budget**
  - Categories: Acquisition, Closing costs, Soft costs, Hard costs, Financing, Contingency, Sales & marketing
  - Line items under each, with original budget, approved changes, revised budget, committed, invoiced, paid, and variance
- **Commitments**
  - Contracts / POs by vendor
- **Invoices**
  - Upload the PDF
  - Code it to a budget line
  - Approval (A)
  - Mark paid
- **Change orders**
  - Amount and schedule impact, with approval (A)
  - Updates the revised budget
- **Draws**
  - Requisition package assembled from approved invoices
  - Retainage
  - Lien waiver checklist
  - Lender inspector sign-off
  - Draw status
- **Sales tracker**
  - Per unit: ask, contract price, $/sf, status, closing date
  - Rolls up into projected sellout
- All money math lives in `src/core`:
  - integer cents
  - fully unit-tested
  - no floating-point money anywhere
- Export to Excel for the owner only.

---

## 9. Notifications

- **Events:**
  - assignment
  - due tomorrow
  - overdue
  - @mention
  - approval requested / decided
  - dependency unblocked
  - key date approaching (14 / 7 / 1 days)
  - public-record change
  - file added to a watched folder
- **Channels:**
  - in-app
  - web push (iPhone home-screen app and desktop browsers), which is free
  - email (Resend free plan, rationed per Section 3)
  - a **WhatsApp share button** on every task and alert that opens WhatsApp on the user's own phone with the message pre-filled. The user presses send. This costs nothing and needs no API
- **Email budget:** the free plan allows 100 emails a day, with every recipient counted. If a day's queue would pass 80, hold the non-urgent emails and fold them into the next digest. Never drop an email silently.
- iPhone users only receive push after adding the app to their Home Screen. The first-login flow must walk them through this with a short illustrated guide and then ask for permission.
- **Daily digest** at 7:00am ET: my overdue, today, approvals waiting, blocked.
- **Overdue nudge:** every 2 days to the assignee until the task is done or re-dated. On the third nudge, copy the project owner.
- User preferences per event and channel, with quiet hours.
- Never include dollar figures in push text, email subject lines or WhatsApp share text.

---

## 10. Public records watch (per BBL, nightly)

Pull from NYC Open Data (Socrata), using an app token. **Verify every dataset ID and field name against the live Socrata metadata before coding.** Known working patterns and quirks:

- **PLUTO** `64uk-42ks`
  - Query `$where=bbl=...`
  - Use `residfar` for FAR; never assume FAR from the district
- **DOB NOW job filings** `w9ak-ipjd`
  - Unpadded integer block / lot
  - Borough as a string
  - Column names differ from BIS, e.g. `existingzoningsqft`
- **DOB BIS jobs** `ic3t-wcy2`
  - Query by `house__` + `upper(street_name)`, with `borough='BROOKLYN'`
  - Zero-padded block / lot returns nulls
- **DOB permits, DOB violations, ECB violations, HPD violations**
  - Find current IDs on the portal and confirm them
  - HPD queries use `boroid` / `block` / `lot`
- **DOB complaints, DOB stop-work orders and OATH/ECB hearings**
  - Find the current dataset IDs on the portal and confirm them
- **311 service requests** for the address (noise, illegal work, construction complaints)
- **DOF property tax**: charges, arrears, and whether the lot is on the tax lien sale list
- **ACRIS**
  - Two-step lookup: Legals `8h5j-fqxa` (`borough='3'` as a string, plus block and lot) → document IDs → Master `bnx9-e6tj` and Parties `636b-3b5g`
  - Single-step BBL queries are unreliable
  - The Open Data extract **lags live ACRIS by roughly one to two months**. Show a "data as of" date so nobody mistakes it for real time

Behavior:

- Store snapshots and diff them nightly.
- On any change, create an alert on the project and notify the PM and owner. Examples:
  - job status change
  - permit issued
  - new violation
  - new recording such as a lis pendens, mortgage or deed
  - new complaint or 311 report
  - new tax arrears or lien-sale listing
- **A stop-work order, or a vacate / partial vacate order, is CRITICAL.** It must reach the owner and PM straight away by push and email, even in quiet hours, and it counts against the email budget without being held back.
- **Each violation is tracked through to closure:**
  1. issued
  2. OATH hearing date, entered as a key date
  3. fixed
  4. certificate of correction filed
  5. dismissed or paid
- Every alert gets a one-click **"Create task from this."**
- The Public Records tab shows current DOB jobs and statuses, permits, open violations and recent ACRIS documents, each with a source link.
- Jobs must be:
  - idempotent
  - retried with backoff
  - rate-limit aware

  A failed sync raises an admin alert. It must never fail silently.

---

## 11. Design system — "architectural luxury"

The look should be warm and quiet: think a top architecture firm's monograph or an Aman property site. It must never look like a generic SaaS dashboard.

**Photography leads.**
- Each project has a hero image: full-bleed on the project page, tall cards on the portfolio.
- Photos update from site uploads, with the option to pin a hero.
- Before a photo exists, use an elegant placeholder: the address set in large serif on a stone background. Never a grey icon.

**Palette** (tokens in `src/styles/tokens`; light is the default, with a matching dark mode):

| Token | Value |
|---|---|
| Limestone background | `#F5F2EC` |
| Paper surface | `#FBFAF7` |
| Travertine borders | `#E4DDD1` |
| Ink text | `#1D1B18` |
| Secondary text | `#6B645A` |
| Accent (patinated bronze) | `#8A6A45` |
| Status: done (sage) | `#6F7F62` |
| Status: attention (ochre) | `#B8893A` |
| Status: blocked / overdue (oxblood) | `#8E3B32` |

Status colors are never neon. Never rely on color alone to carry status.

**Type:**
- A refined display serif for addresses and headlines (for example Instrument Serif or Newsreader).
- A precise sans for UI and data (for example Geist or Manrope).
- Tabular numerals for all money and dates.

**Layout:**
- Generous whitespace and a strict 8-pt grid
- Hairline 1px borders; large radii on cards only
- Minimal shadows
- Restrained motion: 150–250ms eases, with photo cards that lift subtly on hover

**Quality bar:**
- WCAG AA contrast
- Full keyboard navigation and ⌘K
- Lighthouse ≥ 90 on every metric
- Every empty, loading and error state is designed, not default

**iPhone (home-screen app):**
- Native feel with the same tokens
- Large-title headers
- A bottom tab bar
- Swipe to complete / snooze
- Safe-area insets respected, with no browser chrome when launched from the Home Screen

Load the `frontend-design` guidance if available, and make choices that do not read as templated defaults.

---

## 12. iPhone app (installable web app, not the App Store)

- This is the same web app, installed on iPhone via Safari → Share → **Add to Home Screen**. It gets its own icon, opens full screen, and receives push notifications. No App Store, no Apple fee.
- Screens: My Tasks, Portfolio, Project (all tabs; Financials gated), Approvals, Notifications, Search.
- **Field-first features:**
  - camera capture straight into project photos or task attachments, compressed on the phone before upload, with date stamp and optional location
  - offline read cache via the service worker
  - check-offs and comments queued while offline, then synced when back online, with conflict handling
- Face ID sign-in through passkeys.
- Links in push and email open straight to the task.
- Build a one-page "Install on your iPhone" guide with screenshots and send it with every invite.
- Test on real iOS Safari as well as desktop Chrome. Test home-screen push specifically, since it has its own iOS quirks.

---

## 13. Pressure testing — required before launch

- **Unit tests** (Vitest) for all of `src/core`:
  - template generation
  - toggle add / remove
  - dependency blocking and cycle prevention
  - relative dates across weekends and holidays
  - money math
  - recurrence
  - nudge schedule
- **Permission matrix test:** every tRPC procedure × every role × `canViewFinancials` on/off × assigned / unassigned. Assert zero leaks, including search, exports, activity, notifications and file URLs. Presigned URLs must be short-lived.
- **E2E tests:**
  - Playwright on web for every critical flow and every role
  - Playwright with a mobile WebKit (iPhone) profile for: login, complete task, photo upload, approve, offline check-off then sync
- **Concurrency:** two users editing the same task or checklist uses optimistic locking with a clear conflict message.
- **Load:** a demo seed of 25 projects, 3,000 tasks and 5,000 files. Portfolio and My Tasks must load in under 1s on broadband. Run a 50-concurrent-user test.
- **Files:**
  - up to 500MB per file (free storage is 10 GB in total, so warn the uploader on anything over 100MB)
  - PDF and image previews
  - virus scan hook
  - version history
- **Time zone:** DST transitions and ET "today" boundaries.
- **Security:**
  - OWASP top-10 review
  - rate limiting on auth
  - CSRF / CORS
  - secrets only in env
  - audit log tamper-proof
- **Backups:** perform and document a restore drill.
- **Final gate:** an independent review subagent runs a full adversarial QA pass. Launch only when it reports no open P0 or P1 issues.

---

## 14. Folder structure per project (built-in storage)

Default folders are:

- Acquisition
- Legal
- Title & Survey
- Environmental
- Design
- DOB & Permits
- Construction
- Photos
- Financial (gated)
- Sales
- Closeout

Folders are editable per template. Files can attach to tasks and appear in both places.

---

## 14A. Additional modules — all required, all free

### A. BBL auto-fill
- This app is **fully separate** from my deal-origination platform (the arieldevg database). Never connect to it, read from it or write to it.
- Typing a BBL or address on a new project fills in the property facts from PLUTO (public NYC Open Data), then pulls the first public-records snapshot:
  - lot and zoning
  - residential FAR, built FAR, unused ZSF

### B. Expiry tracker
- Track every item with an expiry, per project:
  - DOB work permits
  - sidewalk shed, DOT and crane permits
  - TCO (90-day renewals)
  - builder's risk, GL and umbrella policies
  - every vendor's COI (GL, workers' comp, disability)
  - loan maturity and extension options
  - rate caps
  - LPC permits
  - 1031 deadlines
- Reminders go out at 30, 14 and 7 days, then every day once expired.
- Expired items show in red on the project card and in the Needs You rail.
- An expired vendor COI flags that vendor on **every** project they are on.

### C. Vendor and contact directory
- Companies and people, each with:
  - trade / role
  - licenses: GC license, DOB registration, master plumber / electrician numbers, all with expiry dates
  - COIs on file with expiry dates
  - W-9
  - contact details
  - the projects they are on
  - an internal rating and notes
- Vendors link to budget commitments, invoices and task assignments.
- External users (Section 4) are created from directory contacts.

### D. Daily site log (built for the phone)
- One log per project per day. Fields:
  - weather, auto-filled from a free weather API that needs no key (for example Open-Meteo)
  - manpower by trade
  - work performed
  - deliveries
  - inspections, with pass or fail
  - visitors
  - safety incidents
  - delays and their causes
  - photos
- It should take the super under 2 minutes.
- Missing logs on active construction days get a nudge at 5pm.
- Logs export to a dated PDF for lender draws and claims.

### E. Schedule, baseline and slippage
- Tasks and milestones carry planned and actual start / finish dates.
- **Lock a baseline** at the start of Pre-Construction. Re-baselining requires owner approval (A) and keeps history.
- A Gantt view per project, with the critical path computed from the dependencies.
- Each project shows **days ahead or behind** its baseline finish. This number appears on the portfolio card and in the weekly report.

### F. RFIs, submittals and drawing sets
- **RFIs:**
  - number, question, from, to, due date, answer
  - cost and schedule impact
  - attachments
  - status
  - an answered RFI can spawn a change order in one click
- **Submittals:**
  - spec section, item, submitted by, reviewer
  - decision: approved / approved as noted / revise and resubmit / rejected
  - revision history
- **Drawing sets:**
  - upload sets by discipline (A, S, M, E, P, FP)
  - one current set per discipline
  - superseded sheets stamped **SUPERSEDED** in the viewer
  - a "What's current" page the field can trust

### G. Meeting minutes → tasks
- Meeting types: OAC, design, lender and partner meetings.
- Record attendees and agenda.
- Carry open items forward from the last meeting of the same type.
- Every action item becomes an assigned task with a due date.
- Minutes can be sent as a PDF to attendees. This counts against the email budget, so offer a download link instead of attaching when the budget is tight.

### H. Calendar feed
- Each user gets a private, revocable ICS feed URL. It covers their tasks' due dates, plus key dates, inspections, closings, meetings and expiries on their projects.
- It subscribes in Outlook, Google Calendar and iPhone Calendar.
- Financial details never appear in the feed.

### I. Email into a project
- Every project gets an inbound address, e.g. `347-myrtle@in.<domain>`. Use the inbound-email feature of the email provider already in the stack (Resend), and verify it is on the free plan. **Inbound mail counts toward the same 100-a-day quota, so show it in the email budget.**
- A forwarded email is saved to the project's Activity feed, and its attachments go into an "Inbox" folder to be filed.
- Only mail from registered users' addresses is accepted. Everything else is rejected.

### J. Investor / lender portal
- A read-only external role for an equity investor, JV partner or lender. It sees only:
  - the projects granted
  - a summary of phase and progress
  - photos
  - schedule status
  - the documents shared with them
  - their own capital account, if the financials flag is on
- **Capital tracking:**
  - investors and commitments
  - capital calls (notice, due date, received)
  - distributions
  - each investor's capital account balance
  - the distribution waterfall entered as simple configurable tiers (pref %, return of capital, promote splits), with the calculation unit-tested in `src/core`
- A quarterly investor report is generated as a PDF.

### K. Punch lists on the drawings
- Open a plan sheet PDF in the viewer and tap to drop a pin.
- Each pin becomes a punch item with:
  - photo
  - trade / vendor
  - due date
  - status: open → ready for review → closed
- Filter punch items by floor, unit or trade.
- Export a punch list PDF per sub.
- Use a free PDF viewer library (for example PDF.js). No paid SDKs.

### L. Condo unit tracker
- A unit schedule per project:
  - unit, floor, sf, beds / baths
  - exposure, outdoor space
  - asking price and $/sf
- Buyer upgrades and finish selections per unit, with sign-off deadlines, each feeding a task for the GC.
- Ties into the sales tracker in Section 8.

### M. Portfolio analytics
Owner-only. Across all projects, show:
- actual days per phase, as a median by project type
- actual hard cost and total cost per gross sf and per sellable sf, per project and as benchmarks
- budget variance by category
- where tasks stall, by phase and by person
- the average time to answer an RFI and to approve an invoice

Offer "update template durations from actuals" so the checklist templates get more accurate over time.

### N. Excel import
- Import projects, budgets, the unit schedule, the vendor directory and checklist templates from .xlsx / .csv.
- Column mapping with a preview.
- Validation errors are shown by row.
- **Show the counts at every step:** rows read, rows valid, rows imported and rows rejected, each with a reason. Nothing is dropped silently.

### Excluded because they cost money
- An AI assistant inside the app (API fees)
- Built-in e-signature (DocuSign etc.)

---

## 15. Milestones — build in this order, finish each completely

1. **Foundation**
   - repo, CI on GitHub Actions (lint, typecheck, test on every PR)
   - database and migrations
   - auth and invites, roles, audit log
   - design tokens and component library
   - deploy per Section 3 hosting rule, error logging, and the System page showing free-tier usage
2. **Projects & Portfolio**
   - create / edit project, hero photos
   - portfolio card, table, timeline and map views
   - project page shell
3. **Templates, phases, checklists, toggles**
   - Template studio
   - the full seed library from Section 5
4. **Tasks**
   - assignment, due dates, statuses
   - dependencies, approvals, recurrence
   - comments and @mentions
   - My Tasks, Needs You rail, key dates
5. **Files**
   - storage, folders, versions, previews
   - task attachments, gated Financial folder
6. **Financials**
   - everything in Section 8, with Excel export
7. **Notifications**
   - in-app, email, daily digest, web push
   - WhatsApp share buttons, 2-day nudges, email budget guard, preferences
8. **Public records watch, expiries and violations**
   - Section 10
   - Module B
9. **Field and construction**
   - Modules D, E, F, G and K (daily log, schedule / baseline, RFIs / submittals / drawings, minutes, punch lists)
10. **Directory, BBL auto-fill, investors and units**
    - Modules A (BBL auto-fill), C, J and L
11. **Calendar, email-in, analytics and import**
    - Modules H, I, M and N
12. **iPhone home-screen app**
    - Section 12, tested on a real iPhone, including every field module (daily log, punch pins, camera capture)
13. **Reports, search, polish and launch**
    - weekly owner report
    - ⌘K search
    - the full pressure test from Section 13
    - production cut-over with an empty production database
    - `README.md` and a one-page team guide

**Definition of Done for every milestone:**
- tests green
- review subagent findings fixed
- deployed to preview
- visually checked on desktop and on an iPhone-sized viewport
- `PROGRESS.md` updated
- preview link sent to me

---

## 16. Accounts I will supply — no new cost; ask for each only when its milestone needs it

- GitHub (free private repo; CI and the nightly backup)
- Vercel Pro team (already paid): hosting, Blob storage, Cron
- Neon (Free plan) for this app's database
- Resend (Free plan), plus DNS access to add its records to our domain
- Sentry (free), only if its terms allow business use
- NYC Open Data app token (free)
- The domain for the app, e.g. `projects.liandev.com`. This uses a domain we already own, so there is no new cost

Where an account is not ready yet, build against a local or mock adapter behind an interface, and swap in the real one when I provide it. Never block the whole build on a credential.

**Not used, because they cost money:** Twilio, SMS, the WhatsApp Business API, the Apple Developer Program / App Store, Expo EAS paid builds, Inngest, Cloudflare, an in-app AI assistant, e-signature, and any paid tier of anything.
