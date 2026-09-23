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
    purpose: text("purpose", { enum: ["photo"] }).notNull(),
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
