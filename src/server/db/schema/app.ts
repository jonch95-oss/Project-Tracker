import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { sql } from "drizzle-orm";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Companies that appear on projects and reports. */
export const company = pgTable("company", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  shortName: text("short_name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
});

export const invitation = pgTable(
  "invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role", { enum: ["owner", "admin", "member", "external"] }).notNull(),
    title: text("title"),
    company: text("company"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedById: text("invited_by_id").references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedUserId: text("accepted_user_id").references(() => user.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("invitation_email_idx").on(t.email)],
);

export const PROJECT_TYPES = [
  "ground_up_condo",
  "gut_renovation",
  "contract_flip",
  "foreclosure_auction",
  "condo_conversion",
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const project = pgTable(
  "project",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    address: text("address").notNull(),
    borough: text("borough").notNull().default("Brooklyn"),
    bbl: text("bbl"),
    type: text("type", { enum: PROJECT_TYPES }).notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => company.id),
    status: text("status", { enum: ["active", "on_hold", "closed"] }).notNull().default("active"),
    description: text("description"),
    // Key facts (manual now; filled from PLUTO by BBL auto-fill in Milestone 10).
    lotAreaSqft: integer("lot_area_sqft"),
    zoning: text("zoning"),
    residFar: numeric("resid_far", { precision: 6, scale: 2, mode: "number" }),
    builtFar: numeric("built_far", { precision: 6, scale: 2, mode: "number" }),
    unusedZsf: integer("unused_zsf"),
    units: integer("units"),
    grossSf: integer("gross_sf"),
    sellableSf: integer("sellable_sf"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    /** Pinned hero photo; when null the newest photo is the hero. */
    heroPhotoId: uuid("hero_photo_id"),
    /** Toggles that are on (brief §5.3). */
    toggles: jsonb("toggles").$type<string[]>().notNull().default([]),
    /** The template (and its revision) the checklist was generated from. */
    templateId: uuid("template_id"),
    templateVersion: integer("template_version"),
    createdById: text("created_by_id").references(() => user.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /** Optimistic-locking version; bumped on every update. */
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("project_company_idx").on(t.companyId), index("project_bbl_idx").on(t.bbl)],
);

export const projectMember = pgTable(
  "project_member",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectRole: text("project_role").notNull(),
    canViewFinancials: boolean("can_view_financials").notNull().default(false),
    canEditChecklist: boolean("can_edit_checklist").notNull().default(false),
    canApprove: boolean("can_approve").notNull().default(false),
    addedById: text("added_by_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index("project_member_user_idx").on(t.userId)],
);

/**
 * Append-only, hash-chained. A trigger (see migrations) rejects UPDATE,
 * DELETE and TRUNCATE; `seq` is assigned under an advisory lock so the chain
 * is strictly ordered.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    seq: bigint("seq", { mode: "number" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, precision: 3 }).notNull(),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    projectId: text("project_id"),
    summary: text("summary").notNull(),
    data: jsonb("data"),
    ip: text("ip"),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    index("audit_occurred_idx").on(t.occurredAt),
    index("audit_actor_idx").on(t.actorId),
    index("audit_entity_idx").on(t.entityType, t.entityId),
    index("audit_project_idx").on(t.projectId),
  ],
);

export const errorLog = pgTable(
  "error_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source").notNull(), // "trpc" | "request" | "job" | "client"
    fingerprint: text("fingerprint").notNull(),
    message: text("message").notNull(),
    stack: text("stack"),
    path: text("path"),
    userId: text("user_id"),
    context: jsonb("context"),
  },
  (t) => [index("error_occurred_idx").on(t.occurredAt), index("error_fingerprint_idx").on(t.fingerprint)],
);

export const EMAIL_CATEGORIES = [
  "invite",
  "password_reset",
  "approval",
  "digest",
  "nudge",
  "report",
  "system",
] as const;

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    html: text("html").notNull(),
    text: text("text").notNull(),
    category: text("category", { enum: EMAIL_CATEGORIES }).notNull(),
    urgent: boolean("urgent").notNull().default(false),
    /** Stop-work / vacate orders: sent whatever the budget, retries included (brief §10). */
    critical: boolean("critical").notNull().default(false),
    status: text("status", { enum: ["queued", "sent", "held", "failed", "skipped"] })
      .notNull()
      .default("queued"),
    /** UTC calendar date the email counts against (Resend's daily quota resets at 00:00 UTC). */
    sendDate: text("send_date"),
    providerId: text("provider_id"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [index("email_status_idx").on(t.status), index("email_send_date_idx").on(t.sendDate)],
);

export const jobRun = pgTable(
  "job_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    job: text("job").notNull(),
    trigger: text("trigger").notNull().default("schedule"), // schedule | manual | actions-report
    status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    /** Runner minutes billed by GitHub Actions for this run (rounded up per job). */
    billableMinutes: integer("billable_minutes").notNull().default(0),
    detail: jsonb("detail"),
    error: text("error"),
  },
  (t) => [index("job_run_started_idx").on(t.startedAt), index("job_run_job_idx").on(t.job)],
);

/** One row per (service metric, period, level) we have already emailed about. */
export const usageAlert = pgTable(
  "usage_alert",
  {
    key: text("key").notNull(),
    periodKey: text("period_key").notNull(),
    level: text("level", { enum: ["warn", "critical", "exceeded"] }).notNull(),
    usedValue: bigint("used_value", { mode: "number" }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.key, t.periodKey, t.level] })],
);

/** Counters we meter ourselves (e.g. Blob bytes stored and downloaded) per period. */
export const usageCounter = pgTable(
  "usage_counter",
  {
    key: text("key").notNull(),
    periodKey: text("period_key").notNull(),
    value: bigint("value", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.key, t.periodKey] })],
);

/** Latest backup results reported by the backup workflow. */
export const backupRecord = pgTable(
  "backup_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    objectKey: text("object_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdAt: createdAt(),
    kind: text("kind", { enum: ["nightly", "restore-drill"] }).notNull().default("nightly"),
    note: text("note"),
  },
  (t) => [uniqueIndex("backup_object_idx").on(t.objectKey)],
);

/** Headline financial numbers entered by hand (gated by canViewFinancials). Milestone 6 derives budget and spend from the ledger. */
export const projectHeadline = pgTable("project_headline", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => project.id, { onDelete: "cascade" }),
  purchasePriceCents: bigint("purchase_price_cents", { mode: "number" }),
  totalBudgetCents: bigint("total_budget_cents", { mode: "number" }),
  projectedSelloutCents: bigint("projected_sellout_cents", { mode: "number" }),
  /** Senior debt, for equity required and the equity multiple (brief §8). */
  loanAmountCents: bigint("loan_amount_cents", { mode: "number" }),
  /** Take the total budget from the budget lines / sellout from the unit schedule (else the typed figures). */
  useBudgetDetail: boolean("use_budget_detail").notNull().default(false),
  useSalesDetail: boolean("use_sales_detail").notNull().default(false),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
});

export const projectPhase = pgTable(
  "project_phase",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull(),
    status: text("status", { enum: ["pending", "active", "done", "skipped"] }).notNull().default("pending"),
    /** New York calendar dates (YYYY-MM-DD). */
    startedOn: text("started_on"),
    completedOn: text("completed_on"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("project_phase_key_idx").on(t.projectId, t.key), index("project_phase_project_idx").on(t.projectId)],
);

export const projectPhoto = pgTable(
  "project_photo",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    thumbKey: text("thumb_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    thumbBytes: bigint("thumb_bytes", { mode: "number" }).notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    caption: text("caption"),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    uploadedById: text("uploaded_by_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("project_photo_project_idx").on(t.projectId, t.createdAt), uniqueIndex("project_photo_object_idx").on(t.objectKey)],
);

/**
 * An upload the server has authorized but not yet confirmed. The client
 * uploads straight to storage with a short-lived token scoped to exactly these
 * pathnames and sizes; `complete` then checks the stored objects before any
 * record points at them.
 */
export const pendingUpload = pgTable(
  "pending_upload",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    purpose: text("purpose", { enum: ["photo", "file"] }).notNull(),
    /** Pathnames the client may write, with their byte limits and content types. */
    objects: jsonb("objects").$type<{ role: string; pathname: string; maxBytes: number; contentType: string }[]>().notNull(),
    meta: jsonb("meta"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("pending_upload_user_idx").on(t.userId), index("pending_upload_expires_idx").on(t.expiresAt)],
);

/**
 * A checklist template. The whole definition (phases, tasks, rules) is one
 * validated JSON document (see src/core/templates.ts), versioned on every
 * save. Live projects are never rewritten silently: they record the version
 * they came from, and updates are applied per project with a preview.
 */
export const template = pgTable(
  "template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    projectType: text("project_type", { enum: PROJECT_TYPES }).notNull(),
    /** The type's default template (one per type), used for new projects unless another is chosen. */
    isDefault: boolean("is_default").notNull().default(false),
    version: integer("version").notNull().default(1),
    definition: jsonb("definition").notNull(),
    createdById: text("created_by_id").references(() => user.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("template_type_idx").on(t.projectType)],
);

export const templateRevision = pgTable(
  "template_revision",
  {
    templateId: uuid("template_id")
      .notNull()
      .references(() => template.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definition: jsonb("definition").notNull(),
    savedById: text("saved_by_id").references(() => user.id, { onDelete: "set null" }),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.version] })],
);

export const TASK_STATUSES = ["not_started", "in_progress", "waiting", "blocked", "awaiting_approval", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** A checklist item on a project. Milestone 4 adds assignment, comments, approvals and recurrence handling. */
export const task = pgTable(
  "task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    phaseKey: text("phase_key").notNull(),
    /** The template task it came from (null for tasks people added). */
    templateKey: text("template_key"),
    title: text("title").notNull(),
    description: text("description"),
    role: text("role").notNull().default("PM"),
    assigneeId: text("assignee_id").references(() => user.id, { onDelete: "set null" }),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("not_started"),
    blockedReason: text("blocked_reason"),
    waitingOn: text("waiting_on"),
    priority: text("priority", { enum: ["low", "normal", "high"] }).notNull().default("normal"),
    /** New York calendar date. */
    dueOn: text("due_on"),
    dueRule: jsonb("due_rule"),
    /** A person set the date: never recomputed from the rule. */
    dueManual: boolean("due_manual").notNull().default(false),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    approverRole: text("approver_role"),
    approverId: text("approver_id").references(() => user.id, { onDelete: "set null" }),
    /** Last approval decision on this task. */
    approvalDecision: text("approval_decision", { enum: ["approved", "rejected"] }),
    approvalNote: text("approval_note"),
    approvalRequestedAt: timestamp("approval_requested_at", { withTimezone: true }),
    approvalDecidedAt: timestamp("approval_decided_at", { withTimezone: true }),
    approvalDecidedById: text("approval_decided_by_id").references(() => user.id, { onDelete: "set null" }),
    /** Waiting on a third party: when it started and the next automatic follow-up (NY dates). */
    waitingSince: text("waiting_since"),
    followUpOn: text("follow_up_on"),
    /** Recurring tasks: the first task of the series. */
    seriesId: uuid("series_id"),
    /** The occurrence this task's completion created (so reopening removes exactly that one). */
    nextOccurrenceId: uuid("next_occurrence_id"),
    /** Overdue nudges (brief §9): how many for the current due date, and when the last went out. */
    nudgeCount: integer("nudge_count").notNull().default(0),
    nudgedForDue: text("nudged_for_due"),
    lastNudgedOn: text("last_nudged_on"),
    requiredAttachment: text("required_attachment"),
    subItems: jsonb("sub_items").$type<{ id: string; text: string; done: boolean }[]>().notNull().default([]),
    recurrence: jsonb("recurrence"),
    killScreen: boolean("kill_screen").notNull().default(false),
    milestone: boolean("milestone").notNull().default(false),
    toggleSource: jsonb("toggle_source").$type<string[]>().notNull().default([]),
    sortOrder: integer("sort_order").notNull().default(0),
    version: integer("version").notNull().default(1),
    completedOn: text("completed_on"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedById: text("completed_by_id").references(() => user.id, { onDelete: "set null" }),
    createdById: text("created_by_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("task_project_idx").on(t.projectId, t.phaseKey, t.sortOrder),
    index("task_assignee_idx").on(t.assigneeId, t.status),
    index("task_due_idx").on(t.dueOn),
    index("task_series_idx").on(t.seriesId),
    index("task_approver_idx").on(t.approverId, t.status),
  ],
);

export const taskDependency = pgTable(
  "task_dependency",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    dependsOnId: uuid("depends_on_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnId] }), index("task_dependency_on_idx").on(t.dependsOnId)],
);

export const taskComment = pgTable(
  "task_comment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
    /** Text with @[Name](userId) mention tokens. */
    body: text("body").notNull(),
    mentions: jsonb("mentions").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("task_comment_task_idx").on(t.taskId, t.createdAt)],
);

/** Watchers get updates on a task. Watching also shares the task with an outside collaborator (brief §4). */
export const taskWatcher = pgTable(
  "task_watcher",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    addedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.userId] }), index("task_watcher_user_idx").on(t.userId)],
);

export const keyDate = pgTable(
  "key_date",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    label: text("label"),
    /** New York calendar date. */
    date: text("date").notNull(),
    done: boolean("done").notNull().default(false),
    notes: text("notes"),
    createdById: text("created_by_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("key_date_project_idx").on(t.projectId, t.date), index("key_date_date_idx").on(t.date)],
);

/** One row per key-date reminder sent, so a re-run or a moved date never double-sends. */
export const keyDateReminder = pgTable(
  "key_date_reminder",
  {
    keyDateId: uuid("key_date_id")
      .notNull()
      .references(() => keyDate.id, { onDelete: "cascade" }),
    /** The date the reminder was for (a moved date gets fresh reminders). */
    date: text("date").notNull(),
    threshold: integer("threshold").notNull(),
    sentAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.keyDateId, t.date, t.threshold] })],
);

export const NOTIFICATION_KINDS = [
  "assigned",
  "mention",
  "comment",
  "approval_requested",
  "approval_decided",
  "unblocked",
  "due_tomorrow",
  "overdue",
  "key_date",
  "follow_up",
  "record_change",
  "expiry",
  "file_added",
  "digest",
  "system",
] as const;

/**
 * In-app notifications. Text never contains dollar figures (brief §9).
 * Milestone 7 adds push, the digest, preferences and quiet hours on top.
 */
export const notification = pgTable(
  "notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
    projectId: uuid("project_id").references(() => project.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => task.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    body: text("body"),
    /** In-app link, e.g. /projects/…?task=… */
    href: text("href"),
    readAt: timestamp("read_at", { withTimezone: true }),
    /** Web push: pending = not yet decided; sending = claimed by a dispatcher; then sent, skipped (preference / no device) or held for quiet hours. */
    pushState: text("push_state", { enum: ["pending", "sending", "sent", "skipped", "held"] }).notNull().default("pending"),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    /** Stop-work / vacate orders: push and email straight away, through quiet hours and preferences (brief §10). */
    critical: boolean("critical").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("notification_user_idx").on(t.userId, t.readAt, t.createdAt), index("notification_push_idx").on(t.pushState, t.createdAt)],
);

/** One browser or iPhone home-screen app that accepts web push for a person. */
export const pushSubscription = pgTable(
  "push_subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** "iPhone", "Mac · Chrome"… for the device list. */
    label: text("label"),
    failures: integer("failures").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("push_subscription_endpoint_idx").on(t.endpoint), index("push_subscription_user_idx").on(t.userId)],
);

/**
 * Notification preferences (brief §9): per event and channel, quiet hours
 * and the daily digest. A missing row means the defaults.
 */
export const notificationSettings = pgTable("notification_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** { [kind]: { push?: boolean, email?: boolean } } — only channels changed from the default are stored. */
  prefs: jsonb("prefs").$type<Record<string, { push?: boolean; email?: boolean }>>().notNull().default({}),
  /** "HH:MM" New York time, or null for no quiet hours. */
  quietStart: text("quiet_start"),
  quietEnd: text("quiet_end"),
  digest: boolean("digest").notNull().default(true),
  updatedAt: updatedAt(),
});

/** Watch a folder: hear when files are added (brief §9). */
export const folderWatch = pgTable(
  "folder_watch",
  {
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folder.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.folderId, t.userId] })],
);

/**
 * Project folders (brief §14). Created from the template's folder list; the
 * Financial folder is gated: only people with financial visibility on the
 * project ever see it or anything in it.
 */
export const folder = pgTable(
  "folder",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Financial: visible only with canViewFinancials. */
    gated: boolean("gated").notNull().default(false),
    /** The Photos folder also holds the project's site photos. */
    isPhotos: boolean("is_photos").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("folder_project_idx").on(t.projectId, t.sortOrder), uniqueIndex("folder_project_name_idx").on(t.projectId, sql`lower(${t.name})`)],
);

/** Outside collaborators see only folders shared with them (brief §4). */
export const folderShare = pgTable(
  "folder_share",
  {
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folder.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.folderId, t.userId] }), index("folder_share_user_idx").on(t.userId)],
);

/** A document in a folder. Its bytes live in versions; the newest is current. */
export const file = pgTable(
  "file",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folder.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    createdById: text("created_by_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** In the trash since; purged (bytes deleted) after 30 days. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedById: text("deleted_by_id").references(() => user.id, { onDelete: "set null" }),
    version: integer("version").notNull().default(1),
  },
  (t) => [index("file_folder_idx").on(t.folderId, t.deletedAt), index("file_project_idx").on(t.projectId, t.deletedAt)],
);

export const SCAN_STATUSES = ["pending", "clean", "infected", "not_scanned"] as const;

export const fileVersion = pgTable(
  "file_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => file.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    objectKey: text("object_key").notNull(),
    /** Image thumbnail made on the device (images only). */
    thumbKey: text("thumb_key"),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    thumbBytes: bigint("thumb_bytes", { mode: "number" }).notNull().default(0),
    /** Virus-scan hook result (see src/server/services/scan.ts). */
    scanStatus: text("scan_status", { enum: SCAN_STATUSES }).notNull().default("not_scanned"),
    note: text("note"),
    uploadedById: text("uploaded_by_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("file_version_number_idx").on(t.fileId, t.number), uniqueIndex("file_version_object_idx").on(t.objectKey)],
);

/** Files attached to tasks: they live in a folder and show on the task too. */
export const taskAttachment = pgTable(
  "task_attachment",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => file.id, { onDelete: "cascade" }),
    addedById: text("added_by_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.fileId] }), index("task_attachment_file_idx").on(t.fileId)],
);

/* ------------------------------------------------------------------ */
/* Financials (brief §8). Every amount is integer cents.               */
/* ------------------------------------------------------------------ */

const money = (name: string) => bigint(name, { mode: "number" });

export const budgetLine = pgTable(
  "budget_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    name: text("name").notNull(),
    originalCents: money("original_cents").notNull().default(0),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("budget_line_project_idx").on(t.projectId, t.category, t.sortOrder)],
);

/** Contracts / POs by vendor. */
export const commitment = pgTable(
  "commitment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    budgetLineId: uuid("budget_line_id").references(() => budgetLine.id, { onDelete: "set null" }),
    vendorName: text("vendor_name").notNull(),
    /** Directory vendor (Milestone 10). */
    vendorId: uuid("vendor_id"),
    description: text("description"),
    amountCents: money("amount_cents").notNull(),
    status: text("status", { enum: ["draft", "executed", "closed"] }).notNull().default("executed"),
    signedOn: text("signed_on"),
    /** Retainage withheld on this contract's invoices, basis points. */
    retainageBps: integer("retainage_bps").notNull().default(0),
    fileId: uuid("file_id").references(() => file.id, { onDelete: "set null" }),
    version: integer("version").notNull().default(1),
    createdById: text("created_by_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("commitment_project_idx").on(t.projectId)],
);

export const draw = pgTable(
  "draw",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    periodEnd: text("period_end"),
    status: text("status", { enum: ["draft", "submitted", "inspector_approved", "funded"] }).notNull().default("draft"),
    /** Lien waiver checklist: one row per vendor on the draw. */
    lienWaivers: jsonb("lien_waivers").$type<{ vendor: string; received: boolean }[]>().notNull().default([]),
    inspectorName: text("inspector_name"),
    inspectorSignedOn: text("inspector_signed_on"),
    submittedOn: text("submitted_on"),
    fundedOn: text("funded_on"),
    /** Amount the lender actually funded (may differ from the request). */
    fundedCents: money("funded_cents"),
    notes: text("notes"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("draw_project_number_idx").on(t.projectId, t.number)],
);

export const invoice = pgTable(
  "invoice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    budgetLineId: uuid("budget_line_id").references(() => budgetLine.id, { onDelete: "set null" }),
    commitmentId: uuid("commitment_id").references(() => commitment.id, { onDelete: "set null" }),
    vendorName: text("vendor_name").notNull(),
    vendorId: uuid("vendor_id"),
    number: text("number"),
    invoiceDate: text("invoice_date"),
    amountCents: money("amount_cents").notNull(),
    retainageBps: integer("retainage_bps").notNull().default(0),
    status: text("status", { enum: ["received", "approved", "rejected", "paid"] }).notNull().default("received"),
    note: text("note"),
    decisionNote: text("decision_note"),
    decidedById: text("decided_by_id").references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    paidOn: text("paid_on"),
    drawId: uuid("draw_id").references(() => draw.id, { onDelete: "set null" }),
    /** The invoice PDF, kept in the gated Financial folder. */
    fileId: uuid("file_id").references(() => file.id, { onDelete: "set null" }),
    version: integer("version").notNull().default(1),
    createdById: text("created_by_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("invoice_project_idx").on(t.projectId, t.status), index("invoice_draw_idx").on(t.drawId)],
);

export const changeOrder = pgTable(
  "change_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    budgetLineId: uuid("budget_line_id").references(() => budgetLine.id, { onDelete: "set null" }),
    commitmentId: uuid("commitment_id").references(() => commitment.id, { onDelete: "set null" }),
    number: integer("number").notNull(),
    description: text("description").notNull(),
    /** Positive adds to the budget; negative is a credit. */
    amountCents: money("amount_cents").notNull(),
    scheduleDays: integer("schedule_days").notNull().default(0),
    status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
    decisionNote: text("decision_note"),
    decidedById: text("decided_by_id").references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    fileId: uuid("file_id").references(() => file.id, { onDelete: "set null" }),
    version: integer("version").notNull().default(1),
    createdById: text("created_by_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("change_order_project_number_idx").on(t.projectId, t.number)],
);

/** Sales tracker, per unit (brief §8; Module L extends it in Milestone 10). */
export const saleUnit = pgTable(
  "sale_unit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    unit: text("unit").notNull(),
    floor: text("floor"),
    sf: integer("sf"),
    beds: numeric("beds", { precision: 3, scale: 1, mode: "number" }),
    baths: numeric("baths", { precision: 3, scale: 1, mode: "number" }),
    askCents: money("ask_cents"),
    contractCents: money("contract_cents"),
    status: text("status", { enum: ["available", "reserved", "contract", "closed"] }).notNull().default("available"),
    buyerName: text("buyer_name"),
    contractOn: text("contract_on"),
    closingOn: text("closing_on"),
    sortOrder: integer("sort_order").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("sale_unit_project_unit_idx").on(t.projectId, sql`lower(${t.unit})`)],
);

/** Per-project numbering that never goes backwards (change orders, draws), even after a delete. */
export const projectSequence = pgTable(
  "project_sequence",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    last: integer("last").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.kind] })],
);

/* ------------------------------------------------------------------ */
/* Milestone 8: public records watch, violations, expiries             */
/* ------------------------------------------------------------------ */

/** The latest copy of one public record for a project's lot (brief §10), diffed nightly. */
export const recordItem = pgTable(
  "record_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    status: text("status"),
    /** ISO date the record is about. */
    date: text("date"),
    open: boolean("open").notNull().default(false),
    critical: boolean("critical").notNull().default(false),
    url: text("url").notNull(),
    hearingOn: text("hearing_on"),
    expiresOn: text("expires_on"),
    detail: jsonb("detail").$type<Record<string, string | number | null>>().notNull().default({}),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("record_item_key_idx").on(t.projectId, t.source, t.key), index("record_item_kind_idx").on(t.projectId, t.kind, t.open)],
);

/** Sync health per project and source: last success, data freshness, failures. */
export const recordSync = pgTable(
  "record_sync",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    /** The dataset's own "rows updated" time: ACRIS lags live by 1–2 months. */
    dataAsOf: timestamp("data_as_of", { withTimezone: true }),
    rows: integer("rows").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    error: text("error"),
    /** "_run" row only: a lease so the nightly job and "Check now" never sync one project at once. */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /** "_run" row only: the New York date of the last nightly pass (a daytime check doesn't skip the night). */
    nightlyOn: text("nightly_on"),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.source] })],
);

/** A change worth telling people about, on the project's Public Records tab. */
export const recordAlert = pgTable(
  "record_alert",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    itemKey: text("item_key").notNull(),
    kind: text("kind", { enum: ["new", "status", "critical", "resolved"] }).notNull(),
    critical: boolean("critical").notNull().default(false),
    title: text("title").notNull(),
    url: text("url").notNull(),
    /** Stable per change: a re-run never raises the same alert twice. */
    dedupeKey: text("dedupe_key").notNull(),
    taskId: uuid("task_id").references(() => task.id, { onDelete: "set null" }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedById: text("dismissed_by_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("record_alert_dedupe_idx").on(t.projectId, t.dedupeKey), index("record_alert_project_idx").on(t.projectId, t.createdAt)],
);

/** A violation tracked through to closure (brief §10). */
export const violationCase = pgTable(
  "violation_case",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    itemKey: text("item_key").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    url: text("url").notNull(),
    issuedOn: text("issued_on"),
    stage: text("stage", { enum: ["issued", "hearing", "fixed", "correction_filed", "dismissed", "paid", "resolved"] }).notNull().default("issued"),
    hearingOn: text("hearing_on"),
    keyDateId: uuid("key_date_id").references(() => keyDate.id, { onDelete: "set null" }),
    notes: text("notes"),
    closedOn: text("closed_on"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("violation_case_item_idx").on(t.projectId, t.source, t.itemKey), index("violation_case_stage_idx").on(t.projectId, t.stage)],
);

/** Module B: anything with an expiry date. Permits found in public records are added automatically. */
export const expiryItem = pgTable(
  "expiry_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    label: text("label"),
    vendorName: text("vendor_name"),
    /** Normalized vendor name, so one expired COI flags the vendor everywhere. */
    vendorKey: text("vendor_key"),
    expiresOn: text("expires_on").notNull(),
    notes: text("notes"),
    /** Set for items created from a public record ("source:key"); the sync keeps their dates current. */
    recordRef: text("record_ref"),
    /** Renewed or no longer relevant: stops reminders, keeps history. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdById: text("created_by_id").references(() => user.id, { onDelete: "set null" }),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("expiry_item_project_idx").on(t.projectId, t.expiresOn),
    index("expiry_item_vendor_idx").on(t.vendorKey),
    uniqueIndex("expiry_item_record_idx").on(t.projectId, t.recordRef),
  ],
);

/** One row per expiry reminder sent (for this expiry date), so nothing double-sends. */
export const expiryReminder = pgTable(
  "expiry_reminder",
  {
    itemId: uuid("item_id")
      .notNull()
      .references(() => expiryItem.id, { onDelete: "cascade" }),
    expiresOn: text("expires_on").notNull(),
    mark: text("mark").notNull(),
    sentAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.expiresOn, t.mark] })],
);
