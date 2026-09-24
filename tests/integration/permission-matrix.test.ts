/**
 * Permission matrix: every tRPC procedure × every role × assigned/unassigned
 * × canViewFinancials on/off (+ anonymous and deactivated).
 *
 * The inventory check at the bottom fails when a procedure is added without
 * a matrix row, so new endpoints cannot ship unchecked.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { storage } from "@/server/storage";
import { todayET } from "@/core/time";
import { appRouter } from "@/server/trpc/root";
import { setLotLookupForTests } from "@/server/services/pluto";
import { addMember, callerFor, companyId, createProject, createUser, deactivate } from "../support/fixtures";

type Scenario =
  | "anon"
  | "owner"
  | "admin+fin"
  | "admin"
  | "admin-unassigned"
  | "member+fin"
  | "member"
  | "member-unassigned"
  | "external+fin"
  | "external"
  | "external-unassigned"
  | "investor+fin"
  | "investor"
  | "investor-unassigned"
  | "deactivated";

const SCENARIOS: Scenario[] = [
  "anon",
  "owner",
  "admin+fin",
  "admin",
  "admin-unassigned",
  "member+fin",
  "member",
  "member-unassigned",
  "external+fin",
  "external",
  "external-unassigned",
  "investor+fin",
  "investor",
  "investor-unassigned",
  "deactivated",
];

const ACTIVE: Scenario[] = SCENARIOS.filter((s) => s !== "anon" && s !== "deactivated");
const ASSIGNED: Scenario[] = ["owner", "admin+fin", "admin", "member+fin", "member", "external+fin", "external"];
const OWNER_ONLY: Scenario[] = ["owner"];
/** Can edit the checklist on the matrix project (members lack the flag there). */
const EDITORS: Scenario[] = ["owner", "admin+fin", "admin"];
const INTERNAL_ASSIGNED: Scenario[] = ["owner", "admin+fin", "admin", "member+fin", "member"];
const TEMPLATE_EDITORS: Scenario[] = ["owner", "admin+fin", "admin", "admin-unassigned"];
/** Financial visibility on the matrix project (outsiders only when granted). */
const FIN_VIEW: Scenario[] = ["owner", "admin+fin", "member+fin", "external+fin"];
/** Edit and approve financials: the owner and admins with financial access. */
const FIN_EDIT: Scenario[] = ["owner", "admin+fin"];
/** The directory: internal staff read it; owners and admins keep it. */
const DIR_VIEW: Scenario[] = ["owner", "admin+fin", "admin", "admin-unassigned", "member+fin", "member", "member-unassigned"];
const DIR_EDIT: Scenario[] = ["owner", "admin+fin", "admin", "admin-unassigned"];
/** The investor portal: the internal team (to see what investors see) and the investors on the project. */
const PORTAL: Scenario[] = [...INTERNAL_ASSIGNED, "investor+fin", "investor"];

async function vendorFixture(): Promise<string> {
  const [v] = await db().insert(schema.vendor).values({ name: `Matrix Vendor ${uid()}`, key: `matrix vendor ${uid()}` }).returning({ id: schema.vendor.id });
  return v!.id;
}

async function unitFixture(projectId: string): Promise<{ unitId: string; selectionId: string; version: number }> {
  const [u] = await db().insert(schema.saleUnit).values({ projectId, unit: `M${uid()}` }).returning({ id: schema.saleUnit.id });
  const [sel] = await db().insert(schema.unitSelection).values({ projectId, unitId: u!.id, category: "Kitchen", choice: "Matrix" }).returning();
  return { unitId: u!.id, selectionId: sel!.id, version: sel!.version };
}

async function investorFixture(projectId: string): Promise<string> {
  const [inv] = await db().insert(schema.investor).values({ name: `Matrix Investor ${uid()}` }).returning({ id: schema.investor.id });
  await db().insert(schema.capitalCommitment).values({ projectId, investorId: inv!.id, committedCents: 100_000_00 });
  return inv!.id;
}

async function taskVersion(id: string): Promise<number> {
  const [t] = await db().select({ version: schema.task.version }).from(schema.task).where(eq(schema.task.id, id));
  return t!.version;
}

/** A file in the project's Design folder, added by the owner, straight into the database. */
async function freshFile(projectId: string, opts: { trashed?: boolean } = {}): Promise<string> {
  const [folder] = await db().select().from(schema.folder).where(and(eq(schema.folder.projectId, projectId), eq(schema.folder.name, "Design")));
  const [owner] = await db().select().from(schema.user).where(eq(schema.user.role, "owner")).limit(1);
  const [f] = await db()
    .insert(schema.file)
    .values({ projectId, folderId: folder!.id, name: `Matrix ${uid()}.pdf`, createdById: owner!.id, deletedAt: opts.trashed ? new Date() : null })
    .returning({ id: schema.file.id });
  await db().insert(schema.fileVersion).values({ fileId: f!.id, number: 1, objectKey: `matrix/${uid()}.pdf`, originalName: "m.pdf", contentType: "application/pdf", sizeBytes: 10 });
  return f!.id;
}

async function folderId(projectId: string, name = "Design"): Promise<string> {
  const [folder] = await db().select().from(schema.folder).where(and(eq(schema.folder.projectId, projectId), eq(schema.folder.name, name)));
  return folder!.id;
}

async function fin<T extends "budgetLine" | "invoice" | "changeOrder" | "commitment" | "draw" | "saleUnit">(table: T, projectId: string, values: Record<string, unknown> = {}): Promise<{ id: string; version: number }> {
  const t = schema[table] as never as typeof schema.invoice;
  const base: Record<string, Record<string, unknown>> = {
    budgetLine: { category: "hard", name: `Line ${uid()}`, originalCents: 100 },
    invoice: { vendorName: "V", amountCents: 100 },
    changeOrder: { number: Math.floor(Math.random() * 1e9), description: "x", amountCents: 100 },
    commitment: { vendorName: "V", amountCents: 100 },
    draw: { number: Math.floor(Math.random() * 1e9) },
    saleUnit: { unit: `U${uid()}` },
  };
  const [r] = await db().insert(t).values({ projectId, ...base[table], ...values } as never).returning();
  return { id: (r as { id: string }).id, version: (r as { version: number }).version };
}

/** A plain task on the project, so each call starts from a known state. */
async function freshTask(projectId: string, extra: Partial<typeof schema.task.$inferInsert> = {}): Promise<string> {
  const [t] = await db().insert(schema.task).values({ projectId, phaseKey: "closed", title: `Matrix task ${uid()}`, ...extra }).returning({ id: schema.task.id });
  return t!.id;
}

interface Fixture {
  projectId: string;
  otherUserId: string;
  companyId: string;
  /** A photo on the project uploaded by the owner. */
  photoId: () => Promise<string>;
  /** A task on the project with no prerequisites. */
  taskId: string;
  templateId: string;
  /** An outside collaborator on the project (for folder sharing). */
  externalId: string;
}

type Caller = Awaited<ReturnType<typeof callerFor>>;

interface Row {
  allowed: Scenario[];
  call: (c: Caller, f: Fixture, me: string | null) => Promise<unknown>;
}

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const MATRIX: Record<string, Row | "public"> = {
  "invites.lookup": "public",
  "invites.accept": "public",

  "me.get": { allowed: ACTIVE, call: (c) => c.me.get() },
  "me.updateProfile": {
    allowed: ACTIVE,
    call: async (c) => {
      const me = await c.me.get();
      return c.me.updateProfile({ name: me.name, title: null });
    },
  },

  "users.list": { allowed: OWNER_ONLY, call: (c) => c.users.list() },
  "users.invitations": { allowed: OWNER_ONLY, call: (c) => c.users.invitations() },
  "users.invite": {
    allowed: OWNER_ONLY,
    call: (c) => c.users.invite({ email: `m-${uid()}@example.com`, name: "Matrix", role: "member" }),
  },
  "users.resendInvite": {
    allowed: OWNER_ONLY,
    call: async (c) => {
      const [inv] = await db()
        .insert(schema.invitation)
        .values({ email: `r-${uid()}@example.com`, name: "R", role: "member", tokenHash: uid(), expiresAt: new Date(Date.now() + 86_400_000) })
        .returning();
      return c.users.resendInvite({ invitationId: inv!.id });
    },
  },
  "users.revokeInvite": {
    allowed: OWNER_ONLY,
    call: async (c) => {
      const [inv] = await db()
        .insert(schema.invitation)
        .values({ email: `v-${uid()}@example.com`, name: "V", role: "member", tokenHash: uid(), expiresAt: new Date(Date.now() + 86_400_000) })
        .returning();
      return c.users.revokeInvite({ invitationId: inv!.id });
    },
  },
  "users.setRole": { allowed: OWNER_ONLY, call: (c, f) => c.users.setRole({ userId: f.otherUserId, role: "member" }) },
  "users.setStatus": { allowed: OWNER_ONLY, call: (c, f) => c.users.setStatus({ userId: f.otherUserId, status: "active" }) },
  "users.createResetLink": { allowed: OWNER_ONLY, call: (c, f) => c.users.createResetLink({ userId: f.otherUserId }) },
  "users.access": { allowed: OWNER_ONLY, call: (c, f) => c.users.access({ userId: f.otherUserId }) },

  "companies.list": { allowed: ACTIVE, call: (c) => c.companies.list() },
  "projects.list": { allowed: ACTIVE, call: (c) => c.projects.list() },
  "projects.get": { allowed: ASSIGNED, call: (c, f) => c.projects.get({ projectId: f.projectId }) },
  "projects.update": {
    allowed: ["owner", "admin+fin", "admin"],
    call: async (c, f) => {
      const [p] = await db().select().from(schema.project).where(eq(schema.project.id, f.projectId));
      return c.projects.update({
        projectId: f.projectId,
        version: p!.version,
        name: p!.name,
        address: p!.address,
        borough: "Brooklyn",
        bbl: null,
        companyId: p!.companyId,
        status: "active",
        facts: { units: 12 },
      });
    },
  },
  "projects.setPhase": {
    allowed: ["owner", "admin+fin", "admin"],
    call: async (c, f) => {
      const [p] = await db().select().from(schema.project).where(eq(schema.project.id, f.projectId));
      return c.projects.setPhase({ projectId: f.projectId, key: "pipeline", version: p!.version });
    },
  },
  "projects.skipPhase": {
    allowed: ["owner", "admin+fin", "admin"],
    call: async (c, f) => {
      const [p] = await db().select().from(schema.project).where(eq(schema.project.id, f.projectId));
      return c.projects.skipPhase({ projectId: f.projectId, key: "ag_plan_sales", skipped: false, version: p!.version });
    },
  },
  "projects.setArchived": {
    allowed: ["owner", "admin+fin", "admin"],
    call: (c, f) => c.projects.setArchived({ projectId: f.projectId, archived: false }),
  },
  "projects.activity": {
    allowed: ["owner", "admin+fin", "admin", "member+fin", "member"],
    call: (c, f) => c.projects.activity({ projectId: f.projectId }),
  },

  "photos.list": { allowed: [...ASSIGNED, "investor+fin", "investor"], call: (c, f) => c.photos.list({ projectId: f.projectId }) },
  "photos.beginUpload": {
    allowed: ["owner", "admin+fin", "admin", "member+fin", "member"],
    call: (c, f) => c.photos.beginUpload({ projectId: f.projectId, contentType: "image/webp", fullBytes: 10, thumbBytes: 5, width: 4, height: 3 }),
  },
  "photos.completeUpload": {
    allowed: ["owner", "admin+fin", "admin", "member+fin", "member"],
    call: async (c, f) => {
      const b = await c.photos.beginUpload({ projectId: f.projectId, contentType: "image/webp", fullBytes: 10, thumbBytes: 5, width: 4, height: 3 });
      for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(o.role === "full" ? 10 : 5), { contentType: "image/webp" });
      return c.photos.completeUpload({ projectId: f.projectId, uploadId: b.uploadId });
    },
  },
  "photos.setHero": {
    allowed: ["owner", "admin+fin", "admin"],
    call: async (c, f) => c.photos.setHero({ projectId: f.projectId, photoId: await f.photoId() }),
  },
  "photos.remove": {
    allowed: ["owner", "admin+fin", "admin"],
    call: async (c, f) => c.photos.remove({ projectId: f.projectId, photoId: await f.photoId() }),
  },
  "checklist.get": { allowed: ASSIGNED, call: (c, f) => c.checklist.get({ projectId: f.projectId }) },
  "checklist.setDone": {
    allowed: INTERNAL_ASSIGNED,
    call: async (c, f) => c.checklist.setDone({ projectId: f.projectId, taskId: f.taskId, done: false, version: await taskVersion(f.taskId) }),
  },
  "checklist.addTask": { allowed: EDITORS, call: (c, f) => c.checklist.addTask({ projectId: f.projectId, phaseKey: "pipeline", title: `Matrix ${uid()}` }) },
  "checklist.updateTask": {
    allowed: EDITORS,
    call: async (c, f) => c.checklist.updateTask({ projectId: f.projectId, taskId: f.taskId, version: await taskVersion(f.taskId), role: "Acquisitions" }),
  },
  "checklist.deleteTask": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [t] = await db().insert(schema.task).values({ projectId: f.projectId, phaseKey: "pipeline", title: "Temp" }).returning({ id: schema.task.id });
      return c.checklist.deleteTask({ projectId: f.projectId, taskId: t!.id });
    },
  },
  "checklist.reorder": {
    allowed: EDITORS,
    call: async (c, f) => {
      const ids = (await db().select({ id: schema.task.id }).from(schema.task).where(and(eq(schema.task.projectId, f.projectId), eq(schema.task.phaseKey, "closing")))).map((r) => r.id);
      return c.checklist.reorder({ projectId: f.projectId, phaseKey: "closing", taskIds: ids });
    },
  },
  "checklist.setDependencies": { allowed: EDITORS, call: (c, f) => c.checklist.setDependencies({ projectId: f.projectId, taskId: f.taskId, dependsOnIds: [] }) },
  "checklist.previewToggles": { allowed: EDITORS, call: (c, f) => c.checklist.previewToggles({ projectId: f.projectId, toggles: ["excavation"] }) },
  "checklist.setToggles": { allowed: EDITORS, call: (c, f) => c.checklist.setToggles({ projectId: f.projectId, toggles: [] }) },
  "checklist.renamePhase": { allowed: EDITORS, call: (c, f) => c.checklist.renamePhase({ projectId: f.projectId, key: "pipeline", name: "Pipeline" }) },
  "checklist.addPhase": { allowed: EDITORS, call: (c, f) => c.checklist.addPhase({ projectId: f.projectId, name: `Extra ${uid()}`, afterKey: "closed" }) },
  "checklist.saveAsTemplate": { allowed: EDITORS, call: (c, f) => c.checklist.saveAsTemplate({ projectId: f.projectId, name: `From matrix ${uid()}` }) },

  "templates.list": { allowed: TEMPLATE_EDITORS, call: (c) => c.templates.list() },
  "templates.get": { allowed: TEMPLATE_EDITORS, call: (c, f) => c.templates.get({ templateId: f.templateId }) },
  "templates.create": { allowed: TEMPLATE_EDITORS, call: (c) => c.templates.create({ name: `T ${uid()}`, from: { projectType: "contract_flip" } }) },
  "templates.save": {
    allowed: TEMPLATE_EDITORS,
    call: async (c, f) => {
      const t = await c.templates.get({ templateId: f.templateId }).catch(() => null);
      const [row] = await db().select().from(schema.template).where(eq(schema.template.id, f.templateId));
      return c.templates.save({ templateId: f.templateId, version: t?.version ?? row!.version, definition: (t?.definition ?? row!.definition) as never });
    },
  },
  "templates.setDefault": { allowed: TEMPLATE_EDITORS, call: (c, f) => c.templates.setDefault({ templateId: f.templateId }) },
  "templates.setArchived": {
    allowed: TEMPLATE_EDITORS,
    call: async (c, f) => {
      const [row] = await db().insert(schema.template).values({ name: "Archivable", projectType: "contract_flip", definition: (await db().select().from(schema.template).where(eq(schema.template.id, f.templateId)))[0]!.definition }).returning({ id: schema.template.id });
      return c.templates.setArchived({ templateId: row!.id, archived: true });
    },
  },
  "templates.preview": {
    allowed: TEMPLATE_EDITORS,
    call: async (c, f) => {
      const [row] = await db().select().from(schema.template).where(eq(schema.template.id, f.templateId));
      return c.templates.preview({ definition: row!.definition as never, toggles: ["excavation"] });
    },
  },
  "templates.projects": { allowed: TEMPLATE_EDITORS, call: (c, f) => c.templates.projects({ templateId: f.templateId }) },
  "templates.updatePreview": { allowed: EDITORS, call: (c, f) => c.templates.updatePreview({ projectId: f.projectId }) },
  "templates.applyUpdate": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [t] = await db().select({ version: schema.template.version }).from(schema.template).where(eq(schema.template.id, f.templateId));
      return c.templates.applyUpdate({ projectIds: [f.projectId], expectedVersion: t!.version });
    },
  },
  "checklist.templateUpdatePreview": { allowed: EDITORS, call: (c, f) => c.checklist.templateUpdatePreview({ projectId: f.projectId }) },
  "checklist.applyTemplateUpdate": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [t] = await db().select({ version: schema.template.version }).from(schema.template).where(eq(schema.template.id, f.templateId));
      return c.checklist.applyTemplateUpdate({ projectId: f.projectId, expectedVersion: t!.version });
    },
  },
  "checklist.setSubItem": {
    allowed: INTERNAL_ASSIGNED,
    call: async (c, f) => {
      const [t] = await db().select().from(schema.task).where(and(eq(schema.task.projectId, f.projectId), eq(schema.task.templateKey, "dot_permits")));
      return c.checklist.setSubItem({ projectId: f.projectId, taskId: t!.id, itemId: t!.subItems[0]!.id, done: false });
    },
  },

  "tasks.detail": { allowed: INTERNAL_ASSIGNED, call: (c, f) => c.tasks.detail({ projectId: f.projectId, taskId: f.taskId }) },
  "tasks.assign": {
    allowed: EDITORS,
    call: async (c, f) => {
      const id = await freshTask(f.projectId);
      return c.tasks.assign({ projectId: f.projectId, taskId: id, version: 1, assigneeId: f.otherUserId });
    },
  },
  "tasks.setStatus": {
    allowed: INTERNAL_ASSIGNED,
    call: async (c, f) => c.tasks.setStatus({ projectId: f.projectId, taskId: await freshTask(f.projectId), version: 1, status: "in_progress" }),
  },
  "tasks.setPriority": {
    allowed: EDITORS,
    call: async (c, f) => c.tasks.setPriority({ projectId: f.projectId, taskId: await freshTask(f.projectId), version: 1, priority: "high" }),
  },
  "tasks.decide": {
    allowed: EDITORS,
    // Each caller is the named approver; only those with approve rights may act on it.
    call: async (c, f, me) => c.tasks.decide({ projectId: f.projectId, taskId: await freshTask(f.projectId, { status: "awaiting_approval", requiresApproval: true, approverId: me }), version: 1, decision: "approved" }),
  },
  "tasks.addComment": { allowed: INTERNAL_ASSIGNED, call: (c, f) => c.tasks.addComment({ projectId: f.projectId, taskId: f.taskId, body: "Matrix comment" }) },
  "tasks.editComment": {
    allowed: INTERNAL_ASSIGNED,
    call: async (c, f) => {
      const { id } = await c.tasks.addComment({ projectId: f.projectId, taskId: f.taskId, body: "To edit" });
      return c.tasks.editComment({ projectId: f.projectId, taskId: f.taskId, commentId: id, body: "Edited" });
    },
  },
  "tasks.deleteComment": {
    allowed: INTERNAL_ASSIGNED,
    call: async (c, f) => {
      const { id } = await c.tasks.addComment({ projectId: f.projectId, taskId: f.taskId, body: "To remove" });
      return c.tasks.deleteComment({ projectId: f.projectId, taskId: f.taskId, commentId: id });
    },
  },
  "tasks.watch": { allowed: INTERNAL_ASSIGNED, call: (c, f) => c.tasks.watch({ projectId: f.projectId, taskId: f.taskId, on: true }) },
  "tasks.setWatcher": { allowed: EDITORS, call: (c, f) => c.tasks.setWatcher({ projectId: f.projectId, taskId: f.taskId, userId: f.otherUserId, on: true }) },
  "tasks.bulk": {
    allowed: EDITORS,
    call: async (c, f) => c.tasks.bulk({ projectId: f.projectId, taskIds: [await freshTask(f.projectId)], action: { kind: "redate", dueOn: "2030-01-15" } }),
  },
  "tasks.shiftPhase": { allowed: EDITORS, call: (c, f) => c.tasks.shiftPhase({ projectId: f.projectId, phaseKey: "closed", days: 1, unit: "business" }) },
  "tasks.mine": { allowed: ACTIVE, call: (c) => c.tasks.mine() },
  "tasks.needsYou": { allowed: ACTIVE, call: (c) => c.tasks.needsYou() },

  "keyDates.list": { allowed: INTERNAL_ASSIGNED, call: (c, f) => c.keyDates.list({ projectId: f.projectId }) },
  "keyDates.save": { allowed: EDITORS, call: (c, f) => c.keyDates.save({ projectId: f.projectId, kind: "closing", date: "2030-02-01" }) },
  "keyDates.remove": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [d] = await db().insert(schema.keyDate).values({ projectId: f.projectId, kind: "auction", date: "2030-03-01" }).returning();
      return c.keyDates.remove({ projectId: f.projectId, id: d!.id });
    },
  },

  "notifications.list": { allowed: ACTIVE, call: (c) => c.notifications.list() },
  "notifications.unreadCount": { allowed: ACTIVE, call: (c) => c.notifications.unreadCount() },
  "notifications.markRead": { allowed: ACTIVE, call: (c) => c.notifications.markRead({ ids: ["00000000-0000-4000-8000-000000000000"] }) },
  "notifications.markAllRead": { allowed: ACTIVE, call: (c) => c.notifications.markAllRead() },
  "records.overview": { allowed: INTERNAL_ASSIGNED, call: (c, f) => c.records.overview({ projectId: f.projectId }) },
  "records.syncNow": {
    allowed: EDITORS,
    // Allowed means "got past the permission check": no BBL or the cooldown answer with their own codes.
    call: (c, f) => c.records.syncNow({ projectId: f.projectId }).catch((e: { code?: string }) => { if (e.code !== "BAD_REQUEST" && e.code !== "TOO_MANY_REQUESTS") throw e; }),
  },
  "records.dismissAlert": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [a] = await db().insert(schema.recordAlert).values({ projectId: f.projectId, source: "dob_violations", itemKey: uid(), kind: "new", title: "New violation", url: "https://x", dedupeKey: uid() }).returning();
      return c.records.dismissAlert({ projectId: f.projectId, alertId: a!.id });
    },
  },
  "records.createTask": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [a] = await db().insert(schema.recordAlert).values({ projectId: f.projectId, source: "dob_violations", itemKey: uid(), kind: "new", title: "New violation", url: "https://x", dedupeKey: uid() }).returning();
      return c.records.createTask({ projectId: f.projectId, alertId: a!.id });
    },
  },
  "records.updateViolation": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [v] = await db().insert(schema.violationCase).values({ projectId: f.projectId, source: "dob_violations", itemKey: uid(), title: "DOB violation", url: "https://x" }).returning();
      return c.records.updateViolation({ projectId: f.projectId, id: v!.id, version: 1, stage: "fixed" });
    },
  },
  "expiries.list": { allowed: INTERNAL_ASSIGNED, call: (c, f) => c.expiries.list({ projectId: f.projectId }) },
  "expiries.save": { allowed: EDITORS, call: (c, f) => c.expiries.save({ projectId: f.projectId, category: "gl_policy", expiresOn: "2031-01-01" }) },
  "expiries.close": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [e] = await db().insert(schema.expiryItem).values({ projectId: f.projectId, category: "gl_policy", expiresOn: "2031-01-01" }).returning();
      return c.expiries.close({ projectId: f.projectId, id: e!.id, version: 1, closed: true });
    },
  },
  "expiries.remove": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [e] = await db().insert(schema.expiryItem).values({ projectId: f.projectId, category: "gl_policy", expiresOn: "2031-01-01" }).returning();
      return c.expiries.remove({ projectId: f.projectId, id: e!.id });
    },
  },
  "siteLogs.get": { allowed: INTERNAL_ASSIGNED, call: (c, f) => c.siteLogs.get({ projectId: f.projectId, date: "2026-01-02" }) },
  "siteLogs.list": { allowed: INTERNAL_ASSIGNED, call: (c, f) => c.siteLogs.list({ projectId: f.projectId }) },
  "siteLogs.range": { allowed: INTERNAL_ASSIGNED, call: (c, f) => c.siteLogs.range({ projectId: f.projectId, from: "2026-01-01", to: "2026-01-31" }) },
  "siteLogs.save": {
    allowed: INTERNAL_ASSIGNED,
    call: (c, f) => c.siteLogs.save({ projectId: f.projectId, date: `20${10 + Math.floor(Math.random() * 15)}-0${1 + Math.floor(Math.random() * 9)}-${10 + Math.floor(Math.random() * 18)}`, manpower: [], inspections: [], delays: [], weather: { summary: "Clear", highF: null, lowF: null, precipIn: null, windMph: null } }).catch((e: { code?: string }) => { if (e.code !== "CONFLICT") throw e; }),
  },
  "schedule.get": { allowed: INTERNAL_ASSIGNED, call: (c, f) => c.schedule.get({ projectId: f.projectId }) },
  "schedule.setDates": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [t] = await db().insert(schema.task).values({ projectId: f.projectId, phaseKey: "pipeline", title: `Sched ${uid()}` }).returning();
      return c.schedule.setDates({ projectId: f.projectId, taskId: t!.id, version: 1, startOn: "2030-01-01", dueOn: "2030-01-05" });
    },
  },
  "schedule.lock": { allowed: EDITORS, call: (c, f) => c.schedule.lock({ projectId: f.projectId, reason: null }).catch((e: { code?: string }) => { if (e.code !== "BAD_REQUEST") throw e; }) },
  "schedule.requestRebaseline": {
    allowed: EDITORS,
    call: async (c, f) => {
      await db().update(schema.scheduleBaseline).set({ status: "declined" }).where(and(eq(schema.scheduleBaseline.projectId, f.projectId), eq(schema.scheduleBaseline.status, "requested")));
      return c.schedule.requestRebaseline({ projectId: f.projectId, reason: "Matrix check" }).catch((e: { code?: string }) => { if (e.code !== "BAD_REQUEST") throw e; });
    },
  },
  "schedule.decideRebaseline": {
    allowed: OWNER_ONLY,
    call: async (c, f) => {
      await db().update(schema.scheduleBaseline).set({ status: "declined" }).where(and(eq(schema.scheduleBaseline.projectId, f.projectId), eq(schema.scheduleBaseline.status, "requested")));
      const [r] = await db().insert(schema.scheduleBaseline).values({ projectId: f.projectId, number: 100_000 + Math.floor(Math.random() * 900_000), status: "requested", reason: "Matrix" }).returning();
      return c.schedule.decideRebaseline({ projectId: f.projectId, id: r!.id, approve: false });
    },
  },
  "meetings.list": { allowed: INTERNAL_ASSIGNED, call: (c, f) => c.meetings.list({ projectId: f.projectId }) },
  "meetings.get": {
    allowed: INTERNAL_ASSIGNED,
    call: async (c, f) => {
      const [m] = await db().insert(schema.meeting).values({ projectId: f.projectId, type: "other", number: 100_000 + Math.floor(Math.random() * 900_000), heldOn: "2026-01-01" }).returning();
      return c.meetings.get({ projectId: f.projectId, id: m!.id });
    },
  },
  "meetings.create": { allowed: EDITORS, call: (c, f) => c.meetings.create({ projectId: f.projectId, type: "design", heldOn: "2026-02-02", title: null }) },
  "meetings.update": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [m] = await db().insert(schema.meeting).values({ projectId: f.projectId, type: "other", number: 100_000 + Math.floor(Math.random() * 900_000), heldOn: "2026-01-01" }).returning();
      return c.meetings.update({ projectId: f.projectId, id: m!.id, version: 1, title: "x", heldOn: "2026-01-01", attendees: [], agenda: null, notes: null });
    },
  },
  "meetings.saveItem": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [m] = await db().insert(schema.meeting).values({ projectId: f.projectId, type: "other", number: 100_000 + Math.floor(Math.random() * 900_000), heldOn: "2026-01-01" }).returning();
      return c.meetings.saveItem({ projectId: f.projectId, meetingId: m!.id, kind: "note", text: "Matrix note", assigneeId: null, dueOn: null });
    },
  },
  "meetings.deleteItem": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [m] = await db().insert(schema.meeting).values({ projectId: f.projectId, type: "other", number: 100_000 + Math.floor(Math.random() * 900_000), heldOn: "2026-01-01" }).returning();
      const [i] = await db().insert(schema.meetingItem).values({ meetingId: m!.id, kind: "note", text: "x" }).returning();
      return c.meetings.deleteItem({ projectId: f.projectId, id: i!.id });
    },
  },
  "rfis.list": { allowed: ASSIGNED, call: (c, f) => c.rfis.list({ projectId: f.projectId }) },
  "rfis.save": { allowed: EDITORS, call: (c, f) => c.rfis.save({ projectId: f.projectId, subject: "Matrix", question: "?", fromUserId: null, fromName: null, toUserId: null, toName: null, dueOn: null, costImpactCents: null, scheduleImpactDays: null }) },
  "rfis.answer": {
    allowed: ASSIGNED,
    call: async (c, f, me) => {
      const [r] = await db().insert(schema.rfi).values({ projectId: f.projectId, number: 100_000 + Math.floor(Math.random() * 900_000), subject: "x", question: "?", toUserId: me }).returning();
      return c.rfis.answer({ projectId: f.projectId, id: r!.id, version: 1, answer: "Yes" });
    },
  },
  "rfis.setStatus": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [r] = await db().insert(schema.rfi).values({ projectId: f.projectId, number: 100_000 + Math.floor(Math.random() * 900_000), subject: "x", question: "?" }).returning();
      return c.rfis.setStatus({ projectId: f.projectId, id: r!.id, version: 1, status: "closed" });
    },
  },
  "rfis.attach": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [r] = await db().insert(schema.rfi).values({ projectId: f.projectId, number: 100_000 + Math.floor(Math.random() * 900_000), subject: "x", question: "?" }).returning();
      return c.rfis.attach({ projectId: f.projectId, id: r!.id, fileId: await freshFile(f.projectId), on: true });
    },
  },
  "rfis.toChangeOrder": {
    allowed: FIN_EDIT,
    call: async (c, f) => {
      const [r] = await db().insert(schema.rfi).values({ projectId: f.projectId, number: 100_000 + Math.floor(Math.random() * 900_000), subject: "x", question: "?", status: "answered", answer: "y" }).returning();
      return c.rfis.toChangeOrder({ projectId: f.projectId, id: r!.id });
    },
  },
  "submittals.list": { allowed: ASSIGNED, call: (c, f) => c.submittals.list({ projectId: f.projectId }) },
  "submittals.create": { allowed: EDITORS, call: (c, f) => c.submittals.create({ projectId: f.projectId, specSection: null, item: "Matrix", submittedBy: null, reviewerId: null, reviewerName: null, dueOn: null, fileId: null }) },
  "submittals.decide": {
    allowed: ASSIGNED,
    call: async (c, f, me) => {
      const [s] = await db().insert(schema.submittal).values({ projectId: f.projectId, number: 100_000 + Math.floor(Math.random() * 900_000), item: "x", reviewerId: me }).returning();
      await db().insert(schema.submittalRevision).values({ submittalId: s!.id, revision: 0 });
      return c.submittals.decide({ projectId: f.projectId, id: s!.id, version: 1, decision: "approved", notes: null });
    },
  },
  "submittals.resubmit": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [s] = await db().insert(schema.submittal).values({ projectId: f.projectId, number: 100_000 + Math.floor(Math.random() * 900_000), item: "x", status: "rejected" }).returning();
      await db().insert(schema.submittalRevision).values({ submittalId: s!.id, revision: 0, decision: "rejected" });
      return c.submittals.resubmit({ projectId: f.projectId, id: s!.id, version: 1, fileId: null });
    },
  },
  "drawings.list": { allowed: ASSIGNED, call: (c, f) => c.drawings.list({ projectId: f.projectId }) },
  "drawings.createSet": { allowed: EDITORS, call: async (c, f) => c.drawings.createSet({ projectId: f.projectId, discipline: "M", name: "Matrix", issuedOn: null, fileIds: [await freshFile(f.projectId)] }) },
  "drawings.sheet": {
    allowed: INTERNAL_ASSIGNED,
    call: async (c, f) => {
      const [set] = await db().insert(schema.drawingSet).values({ projectId: f.projectId, discipline: "E", name: "Matrix" }).returning();
      const fileId = await freshFile(f.projectId);
      const [v] = await db().select({ id: schema.fileVersion.id }).from(schema.fileVersion).where(eq(schema.fileVersion.fileId, fileId));
      const [sh] = await db().insert(schema.drawingSheet).values({ setId: set!.id, projectId: f.projectId, number: "E-1", fileId, versionId: v!.id }).returning();
      return c.drawings.sheet({ projectId: f.projectId, sheetId: sh!.id });
    },
  },
  "punch.list": { allowed: ASSIGNED, call: (c, f) => c.punch.list({ projectId: f.projectId }) },
  "punch.create": { allowed: INTERNAL_ASSIGNED, call: (c, f) => c.punch.create({ projectId: f.projectId, sheetId: null, page: 1, x: null, y: null, title: "Matrix", description: null, trade: null, vendorName: null, assigneeId: null, floor: null, unit: null, dueOn: null, photoId: null }) },
  "punch.update": {
    allowed: ASSIGNED,
    call: async (c, f, me) => {
      const [p] = await db().insert(schema.punchItem).values({ projectId: f.projectId, number: 100_000 + Math.floor(Math.random() * 900_000), title: "x", assigneeId: me }).returning();
      return c.punch.update({ projectId: f.projectId, id: p!.id, version: 1, status: "ready" });
    },
  },
  "punch.remove": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [p] = await db().insert(schema.punchItem).values({ projectId: f.projectId, number: 100_000 + Math.floor(Math.random() * 900_000), title: "x" }).returning();
      return c.punch.remove({ projectId: f.projectId, id: p!.id });
    },
  },
  "notifySettings.get": { allowed: ACTIVE, call: (c) => c.notifySettings.get() },
  "notifySettings.save": { allowed: ACTIVE, call: (c) => c.notifySettings.save({ prefs: {}, quietStart: null, quietEnd: null, digest: true }) },
  "push.config": { allowed: ACTIVE, call: (c) => c.push.config() },
  "push.devices": { allowed: ACTIVE, call: (c) => c.push.devices() },
  "push.subscribe": { allowed: ACTIVE, call: (c) => c.push.subscribe({ endpoint: `https://fcm.googleapis.com/fcm/send/${uid()}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2", auth: "tBHItJI5svbpez7KI4CCXg" } }) },
  "push.unsubscribe": { allowed: ACTIVE, call: (c) => c.push.unsubscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/none" }) },
  "push.test": { allowed: ACTIVE, call: (c) => c.push.test().catch((e: { code?: string }) => { if (e.code !== "PRECONDITION_FAILED") throw e; }) },
  "push.removeDevice": { allowed: ACTIVE, call: (c) => c.push.removeDevice({ id: "00000000-0000-4000-8000-000000000000" }) },

  "files.folders": { allowed: [...ASSIGNED, "investor+fin", "investor"], call: (c, f) => c.files.folders({ projectId: f.projectId }) },
  "files.list": { allowed: INTERNAL_ASSIGNED, call: async (c, f) => c.files.list({ projectId: f.projectId, folderId: await folderId(f.projectId) }) },
  "files.canRead": { allowed: INTERNAL_ASSIGNED, call: async (c, f) => c.files.canRead({ projectId: f.projectId, fileId: await freshFile(f.projectId) }) },
  "files.get": { allowed: INTERNAL_ASSIGNED, call: async (c, f) => c.files.get({ projectId: f.projectId, fileId: await freshFile(f.projectId) }) },
  "files.beginUpload": {
    allowed: INTERNAL_ASSIGNED,
    call: async (c, f) => c.files.beginUpload({ projectId: f.projectId, folderId: await folderId(f.projectId), name: "a.pdf", contentType: "application/pdf", sizeBytes: 10 }),
  },
  "files.completeUpload": {
    allowed: INTERNAL_ASSIGNED,
    call: async (c, f) => {
      const b = await c.files.beginUpload({ projectId: f.projectId, folderId: await folderId(f.projectId), name: "a.pdf", contentType: "application/pdf", sizeBytes: 10 });
      for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(10), { contentType: o.contentType });
      return c.files.completeUpload({ projectId: f.projectId, uploadId: b.uploadId });
    },
  },
  "files.rename": { allowed: EDITORS, call: async (c, f) => c.files.rename({ projectId: f.projectId, fileId: await freshFile(f.projectId), version: 1, name: "Renamed.pdf" }) },
  "files.move": { allowed: EDITORS, call: async (c, f) => c.files.move({ projectId: f.projectId, fileId: await freshFile(f.projectId), version: 1, folderId: await folderId(f.projectId, "Legal") }) },
  "files.remove": { allowed: EDITORS, call: async (c, f) => c.files.remove({ projectId: f.projectId, fileId: await freshFile(f.projectId) }) },
  "files.trash": { allowed: EDITORS, call: (c, f) => c.files.trash({ projectId: f.projectId }) },
  "files.restore": { allowed: EDITORS, call: async (c, f) => c.files.restore({ projectId: f.projectId, fileId: await freshFile(f.projectId, { trashed: true }) }) },
  "files.purge": { allowed: EDITORS, call: async (c, f) => c.files.purge({ projectId: f.projectId, fileId: await freshFile(f.projectId, { trashed: true }) }) },
  "files.attach": { allowed: INTERNAL_ASSIGNED, call: async (c, f) => c.files.attach({ projectId: f.projectId, taskId: f.taskId, fileId: await freshFile(f.projectId) }) },
  "files.detach": { allowed: INTERNAL_ASSIGNED, call: async (c, f) => c.files.detach({ projectId: f.projectId, taskId: f.taskId, fileId: await freshFile(f.projectId) }) },
  "files.forTask": { allowed: INTERNAL_ASSIGNED, call: (c, f) => c.files.forTask({ projectId: f.projectId, taskId: f.taskId }) },
  "files.createFolder": { allowed: EDITORS, call: (c, f) => c.files.createFolder({ projectId: f.projectId, name: `Folder ${uid()}` }) },
  "files.renameFolder": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [x] = await db().insert(schema.folder).values({ projectId: f.projectId, name: `R ${uid()}` }).returning();
      return c.files.renameFolder({ projectId: f.projectId, folderId: x!.id, name: `R2 ${uid()}` });
    },
  },
  "files.deleteFolder": {
    allowed: EDITORS,
    call: async (c, f) => {
      const [x] = await db().insert(schema.folder).values({ projectId: f.projectId, name: `D ${uid()}` }).returning();
      return c.files.deleteFolder({ projectId: f.projectId, folderId: x!.id });
    },
  },
  "files.watchFolder": { allowed: INTERNAL_ASSIGNED, call: async (c, f) => c.files.watchFolder({ projectId: f.projectId, folderId: await folderId(f.projectId), on: true }) },
  "files.shareFolder": { allowed: EDITORS, call: async (c, f) => c.files.shareFolder({ projectId: f.projectId, folderId: await folderId(f.projectId), userId: f.externalId, on: true }) },

  "financials.overview": { allowed: FIN_VIEW, call: (c, f) => c.financials.overview({ projectId: f.projectId }) },
  "financials.saveHeadline": { allowed: FIN_EDIT, call: async (c, f) => c.financials.saveHeadline({ projectId: f.projectId, version: (await db().select().from(schema.projectHeadline).where(eq(schema.projectHeadline.projectId, f.projectId)))[0]?.version ?? 0, purchasePriceCents: 1, totalBudgetCents: null, projectedSelloutCents: null, loanAmountCents: null, useBudgetDetail: false, useSalesDetail: false }) },
  "financials.saveLine": { allowed: FIN_EDIT, call: (c, f) => c.financials.saveLine({ projectId: f.projectId, category: "soft", name: `L ${uid()}`, originalCents: 100 }) },
  "financials.deleteLine": { allowed: FIN_EDIT, call: async (c, f) => c.financials.deleteLine({ projectId: f.projectId, ...(await fin("budgetLine", f.projectId)) }) },
  "financials.startBudget": { allowed: FIN_EDIT, call: (c, f) => c.financials.startBudget({ projectId: f.projectId }) },
  "financials.saveCommitment": { allowed: FIN_EDIT, call: (c, f) => c.financials.saveCommitment({ projectId: f.projectId, vendorName: "V", amountCents: 100 }) },
  "financials.deleteCommitment": { allowed: FIN_EDIT, call: async (c, f) => c.financials.deleteCommitment({ projectId: f.projectId, ...(await fin("commitment", f.projectId)) }) },
  "financials.saveInvoice": { allowed: FIN_EDIT, call: (c, f) => c.financials.saveInvoice({ projectId: f.projectId, vendorName: "V", amountCents: 100 }) },
  "financials.decideInvoice": {
    allowed: FIN_EDIT,
    call: async (c, f) => {
      const line = await fin("budgetLine", f.projectId);
      const inv = await fin("invoice", f.projectId, { budgetLineId: line.id });
      return c.financials.decideInvoice({ projectId: f.projectId, id: inv.id, version: inv.version, decision: "approved" });
    },
  },
  "financials.markPaid": {
    allowed: FIN_EDIT,
    call: async (c, f) => {
      const inv = await fin("invoice", f.projectId, { status: "approved" });
      return c.financials.markPaid({ projectId: f.projectId, id: inv.id, version: inv.version, paidOn: "2030-01-02" });
    },
  },
  "financials.reopenInvoice": {
    allowed: FIN_VIEW.filter((x) => x === "owner" || x === "admin+fin"),
    call: async (c, f) => {
      const inv = await fin("invoice", f.projectId, { status: "approved" });
      return c.financials.reopenInvoice({ projectId: f.projectId, id: inv.id, version: inv.version, note: "Wrong amount" });
    },
  },
  "financials.deleteInvoice": { allowed: FIN_EDIT, call: async (c, f) => c.financials.deleteInvoice({ projectId: f.projectId, ...(await fin("invoice", f.projectId)) }) },
  "financials.saveChangeOrder": { allowed: FIN_EDIT, call: (c, f) => c.financials.saveChangeOrder({ projectId: f.projectId, description: "x", amountCents: 100 }) },
  "financials.decideChangeOrder": {
    allowed: FIN_EDIT,
    call: async (c, f) => {
      const line = await fin("budgetLine", f.projectId);
      const co = await fin("changeOrder", f.projectId, { budgetLineId: line.id });
      return c.financials.decideChangeOrder({ projectId: f.projectId, id: co.id, version: co.version, decision: "approved" });
    },
  },
  "financials.deleteChangeOrder": { allowed: FIN_EDIT, call: async (c, f) => c.financials.deleteChangeOrder({ projectId: f.projectId, ...(await fin("changeOrder", f.projectId)) }) },
  "financials.createDraw": {
    allowed: FIN_EDIT,
    call: async (c, f) => {
      await db().update(schema.draw).set({ status: "funded" }).where(and(eq(schema.draw.projectId, f.projectId), eq(schema.draw.status, "draft")));
      return c.financials.createDraw({ projectId: f.projectId });
    },
  },
  "financials.updateDraw": { allowed: FIN_EDIT, call: async (c, f) => { const d = await fin("draw", f.projectId, { status: "submitted" }); return c.financials.updateDraw({ projectId: f.projectId, id: d.id, version: d.version, notes: "n" }); } },
  "financials.advanceDraw": {
    allowed: FIN_EDIT,
    call: async (c, f) => {
      const d = await fin("draw", f.projectId, { status: "inspector_approved" });
      return c.financials.advanceDraw({ projectId: f.projectId, id: d.id, version: d.version });
    },
  },
  "financials.deleteDraw": { allowed: FIN_EDIT, call: async (c, f) => c.financials.deleteDraw({ projectId: f.projectId, ...(await fin("draw", f.projectId, { status: "draft" })) }) },
  "financials.saveUnit": { allowed: FIN_EDIT, call: (c, f) => c.financials.saveUnit({ projectId: f.projectId, unit: `U${uid()}`, status: "available" }) },
  "financials.deleteUnit": { allowed: FIN_EDIT, call: async (c, f) => c.financials.deleteUnit({ projectId: f.projectId, ...(await fin("saleUnit", f.projectId)) }) },

  "projects.create": {
    allowed: ["owner", "admin+fin", "admin", "admin-unassigned"],
    call: (c, f) => c.projects.create({ name: `M ${uid()}`, address: "1 Matrix Pl", type: "gut_renovation", companyId: f.companyId, bbl: null }),
  },

  "members.list": { allowed: ASSIGNED, call: (c, f) => c.members.list({ projectId: f.projectId }) },
  "members.candidates": { allowed: ["owner", "admin+fin", "admin"], call: (c, f) => c.members.candidates({ projectId: f.projectId }) },
  "members.upsert": {
    allowed: ["owner", "admin+fin", "admin"],
    call: (c, f) =>
      c.members.upsert({
        projectId: f.projectId,
        userId: f.otherUserId,
        projectRole: "Consultant",
        canViewFinancials: false,
        canEditChecklist: false,
        canApprove: false,
      }),
  },
  "members.remove": {
    allowed: ["owner", "admin+fin", "admin"],
    call: async (c, f) => {
      const temp = await createUser("member");
      await addMember(f.projectId, temp.id);
      return c.members.remove({ projectId: f.projectId, userId: temp.id });
    },
  },

  "audit.list": { allowed: OWNER_ONLY, call: (c) => c.audit.list({ limit: 5 }) },
  "audit.verify": { allowed: OWNER_ONLY, call: (c) => c.audit.verify() },
  "system.overview": { allowed: OWNER_ONLY, call: (c) => c.system.overview() },

  "projects.lookupLot": { allowed: TEMPLATE_EDITORS, call: (c) => c.projects.lookupLot({ bbl: "3017590013", borough: "Brooklyn" }) },

  "units.list": { allowed: INTERNAL_ASSIGNED, call: (c, f) => c.units.list({ projectId: f.projectId }) },
  "units.saveUnit": { allowed: EDITORS, call: (c, f) => c.units.saveUnit({ projectId: f.projectId, unit: `N${uid()}`, sf: 900 }) },
  "units.saveSelection": { allowed: EDITORS, call: async (c, f) => c.units.saveSelection({ projectId: f.projectId, unitId: (await unitFixture(f.projectId)).unitId, category: "Bath", choice: "Matrix tile" }) },
  "units.signOff": {
    allowed: EDITORS,
    call: async (c, f) => {
      const u = await unitFixture(f.projectId);
      return c.units.signOff({ projectId: f.projectId, id: u.selectionId, version: u.version, signedOffOn: "2026-01-02", signedOffName: "Buyer" });
    },
  },
  "units.deleteSelection": {
    allowed: EDITORS,
    call: async (c, f) => {
      const u = await unitFixture(f.projectId);
      return c.units.deleteSelection({ projectId: f.projectId, id: u.selectionId, version: u.version });
    },
  },

  "directory.list": { allowed: DIR_VIEW, call: (c) => c.directory.list() },
  "directory.options": { allowed: DIR_VIEW, call: (c) => c.directory.options() },
  "directory.get": { allowed: DIR_VIEW, call: async (c) => c.directory.get({ id: await vendorFixture() }) },
  "directory.saveVendor": { allowed: DIR_EDIT, call: (c) => c.directory.saveVendor({ name: `Matrix Co ${uid()}`, kind: "contractor" }) },
  "directory.setArchived": { allowed: DIR_EDIT, call: async (c) => c.directory.setArchived({ id: await vendorFixture(), archived: true }) },
  "directory.saveContact": { allowed: DIR_EDIT, call: async (c) => c.directory.saveContact({ vendorId: await vendorFixture(), name: "Matrix Person" }) },
  "directory.deleteContact": {
    allowed: DIR_EDIT,
    call: async (c) => {
      const [p] = await db().insert(schema.contact).values({ name: "Delete me" }).returning({ id: schema.contact.id });
      return c.directory.deleteContact({ id: p!.id });
    },
  },
  "directory.saveDocument": { allowed: DIR_EDIT, call: async (c) => c.directory.saveDocument({ vendorId: await vendorFixture(), kind: "license", category: "gc_license", expiresOn: "2030-01-01" }) },
  "directory.deleteDocument": {
    allowed: DIR_EDIT,
    call: async (c) => {
      const [d] = await db().insert(schema.vendorDocument).values({ vendorId: await vendorFixture(), kind: "other", category: "other" }).returning({ id: schema.vendorDocument.id });
      return c.directory.deleteDocument({ id: d!.id });
    },
  },
  "directory.beginDocUpload": {
    allowed: DIR_EDIT,
    call: async (c) => {
      const [d] = await db().insert(schema.vendorDocument).values({ vendorId: await vendorFixture(), kind: "w9", category: "w9" }).returning({ id: schema.vendorDocument.id });
      return c.directory.beginDocUpload({ documentId: d!.id, name: "w9.pdf", contentType: "application/pdf", sizeBytes: 10 });
    },
  },
  "directory.completeDocUpload": {
    allowed: DIR_EDIT,
    call: async (c, f, me) => {
      const [d] = await db().insert(schema.vendorDocument).values({ vendorId: await vendorFixture(), kind: "w9", category: "w9" }).returning({ id: schema.vendorDocument.id });
      // Each caller completes an upload it began itself (a stranger's upload id reads as expired).
      const b = await c.directory.beginDocUpload({ documentId: d!.id, name: "w9.pdf", contentType: "application/pdf", sizeBytes: 10 });
      void me;
      for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(10), { contentType: "application/pdf" });
      return c.directory.completeDocUpload({ uploadId: b.uploadId });
    },
  },

  "capital.overview": { allowed: FIN_VIEW, call: (c, f) => c.capital.overview({ projectId: f.projectId }) },
  "capital.saveTerms": {
    allowed: FIN_EDIT,
    call: async (c, f) => {
      const [t] = await db().select({ version: schema.capitalTerms.version }).from(schema.capitalTerms).where(eq(schema.capitalTerms.projectId, f.projectId));
      return c.capital.saveTerms({ projectId: f.projectId, version: t?.version ?? 0, tiers: [{ kind: "return_of_capital" }, { kind: "split", lpBps: 8000, untilMultipleMilli: null }] });
    },
  },
  "capital.saveInvestor": { allowed: FIN_EDIT, call: (c, f) => c.capital.saveInvestor({ projectId: f.projectId, name: `Matrix LP ${uid()}`, kind: "equity", committedCents: 50_000_00 }) },
  "capital.setCommitment": {
    allowed: FIN_EDIT,
    call: async (c, f) => {
      const [inv] = await db().insert(schema.investor).values({ name: `Matrix Attach ${uid()}` }).returning({ id: schema.investor.id });
      return c.capital.setCommitment({ projectId: f.projectId, investorId: inv!.id, committedCents: 1_000_00 });
    },
  },
  "capital.removeInvestor": { allowed: FIN_EDIT, call: async (c, f) => c.capital.removeInvestor({ projectId: f.projectId, investorId: await investorFixture(f.projectId) }) },
  "capital.createCall": {
    allowed: FIN_EDIT,
    call: async (c, f) => {
      await investorFixture(f.projectId);
      return c.capital.createCall({ projectId: f.projectId, noticeOn: "2026-01-02", dueOn: "2026-01-20", totalCents: 10_000_00 });
    },
  },
  "capital.recordReceipt": {
    allowed: FIN_EDIT,
    call: async (c, f) => {
      const inv = await investorFixture(f.projectId);
      const [call] = await db().insert(schema.capitalCall).values({ projectId: f.projectId, number: Math.floor(Math.random() * 1e9), noticeOn: "2026-01-02", dueOn: "2026-01-20" }).returning();
      const [item] = await db().insert(schema.capitalCallItem).values({ callId: call!.id, investorId: inv, amountCents: 100 }).returning();
      return c.capital.recordReceipt({ projectId: f.projectId, itemId: item!.id, version: item!.version, receivedCents: 100, receivedOn: "2026-01-05" });
    },
  },
  "capital.deleteCall": {
    allowed: FIN_EDIT,
    call: async (c, f) => {
      const [call] = await db().insert(schema.capitalCall).values({ projectId: f.projectId, number: Math.floor(Math.random() * 1e9), noticeOn: "2026-01-02", dueOn: "2026-01-20" }).returning();
      return c.capital.deleteCall({ projectId: f.projectId, id: call!.id });
    },
  },
  "capital.previewDistribution": {
    allowed: FIN_EDIT,
    call: async (c, f) => {
      await investorFixture(f.projectId);
      return c.capital.previewDistribution({ projectId: f.projectId, amountCents: 1_000_00, paidOn: "2099-01-01" });
    },
  },
  "capital.recordDistribution": {
    allowed: FIN_EDIT,
    call: async (c, f) => {
      await investorFixture(f.projectId);
      return c.capital.recordDistribution({ projectId: f.projectId, amountCents: 1_000_00, paidOn: todayET() });
    },
  },
  "capital.deleteDistribution": {
    allowed: FIN_EDIT,
    call: async (c, f) => {
      const [latest] = await db().select({ n: schema.distribution.number }).from(schema.distribution).where(eq(schema.distribution.projectId, f.projectId)).orderBy(desc(schema.distribution.number)).limit(1);
      const [d] = await db().insert(schema.distribution).values({ projectId: f.projectId, number: (latest?.n ?? 0) + 1, paidOn: todayET(), totalCents: 100 }).returning();
      return c.capital.deleteDistribution({ projectId: f.projectId, id: d!.id });
    },
  },

  "portal.list": { allowed: ACTIVE.filter((s) => !s.startsWith("external")), call: (c) => c.portal.list() },
  "portal.project": { allowed: PORTAL, call: (c, f) => c.portal.project({ projectId: f.projectId }) },
  "portal.highlights": { allowed: PORTAL, call: (c, f) => c.portal.highlights({ projectId: f.projectId, from: "2026-01-01", to: "2026-03-31" }) },

};

const DENIED_CODES = new Set(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"]);

describe("permission matrix", () => {
  const users = {} as Record<Scenario, string | null>;
  const fixture = {} as Fixture;

  beforeAll(async () => {
    setLotLookupForTests(async () => null);
    const owner = await createUser("owner");
    users.owner = owner.id;
    users.anon = null;
    const p = await createProject(owner.id, "Matrix Project");
    fixture.projectId = p.id;
    fixture.companyId = await companyId();
    fixture.otherUserId = (await createUser("member")).id;
    const [firstTask] = await db().select({ id: schema.task.id }).from(schema.task).where(and(eq(schema.task.projectId, p.id), eq(schema.task.templateKey, "mih_check")));
    fixture.taskId = firstTask!.id;
    const [proj] = await db().select({ templateId: schema.project.templateId }).from(schema.project).where(eq(schema.project.id, p.id));
    fixture.templateId = proj!.templateId!;
    const ownerCaller = await callerFor(owner.id);
    fixture.photoId = async () => {
      const b = await ownerCaller.photos.beginUpload({ projectId: p.id, contentType: "image/webp", fullBytes: 10, thumbBytes: 5, width: 4, height: 3 });
      for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(o.role === "full" ? 10 : 5), { contentType: "image/webp" });
      return (await ownerCaller.photos.completeUpload({ projectId: p.id, uploadId: b.uploadId })).id;
    };
    await addMember(fixture.projectId, fixture.otherUserId);

    for (const role of ["admin", "member", "external", "investor"] as const) {
      const withFin = await createUser(role);
      await addMember(p.id, withFin.id, { canViewFinancials: true });
      users[`${role}+fin`] = withFin.id;
      const noFin = await createUser(role);
      await addMember(p.id, noFin.id);
      users[role] = noFin.id;
      users[`${role}-unassigned`] = (await createUser(role)).id;
    }
    fixture.externalId = users.external!;
    const d = await createUser("member");
    await addMember(p.id, d.id, { canViewFinancials: true });
    await deactivate(d.id);
    users.deactivated = d.id;
  });

  for (const [path, row] of Object.entries(MATRIX)) {
    if (row === "public") continue;
    describe(path, () => {
      for (const scenario of SCENARIOS) {
        const expectAllowed = row.allowed.includes(scenario);
        it(`${scenario}: ${expectAllowed ? "allowed" : "denied"}`, async () => {
          const caller = await callerFor(users[scenario]);
          let error: unknown = null;
          try {
            await row.call(caller, fixture, users[scenario]);
          } catch (e) {
            error = e;
          }
          if (expectAllowed) {
            expect(error, `${path} should succeed for ${scenario}: ${String(error)}`).toBeNull();
          } else {
            expect(error).toBeInstanceOf(TRPCError);
            expect(DENIED_CODES.has((error as TRPCError).code), `unexpected code ${(error as TRPCError).code}`).toBe(true);
          }
        });
      }
    });
  }

  it("covers every procedure in the router", () => {
    const procedures = Object.keys((appRouter._def as unknown as { procedures: Record<string, unknown> }).procedures).sort();
    expect(procedures.length).toBeGreaterThan(10);
    expect(Object.keys(MATRIX).sort()).toEqual(procedures);
  });

  it("unassigned users get NOT_FOUND, so project existence does not leak", async () => {
    for (const s of ["admin-unassigned", "member-unassigned", "external-unassigned"] as const) {
      const c = await callerFor(users[s]);
      await expect(c.projects.get({ projectId: fixture.projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
      const list = await c.projects.list();
      expect(list.projects.find((p) => p.id === fixture.projectId)).toBeUndefined();
    }
  });

  it("project access reports financial visibility exactly as flagged", async () => {
    const expectations: [Scenario, boolean][] = [
      ["owner", true],
      ["admin+fin", true],
      ["admin", false],
      ["member+fin", true],
      ["member", false],
      ["external+fin", true],
      ["external", false],
    ];
    for (const [s, fin] of expectations) {
      const c = await callerFor(users[s]);
      const p = await c.projects.get({ projectId: fixture.projectId });
      expect(p.access.canViewFinancials, s).toBe(fin);
    }
  });

  it("externals do not see other members' emails or permission flags", async () => {
    const c = await callerFor(users.external);
    const members = await c.members.list({ projectId: fixture.projectId });
    expect(members.length).toBeGreaterThan(3);
    for (const m of members) {
      expect(m.email).toBeNull();
      expect(m.flags).toBeNull();
      expect(m.globalRole).toBeNull();
    }
    const asMember = await (await callerFor(users.member)).members.list({ projectId: fixture.projectId });
    expect(asMember.every((m) => m.flags === null)).toBe(true);
  });

  it("admins cannot grant financial visibility they do not have", async () => {
    const target = await createUser("member");
    const admin = await callerFor(users.admin);
    await expect(
      admin.members.upsert({ projectId: fixture.projectId, userId: target.id, projectRole: "PM", canViewFinancials: true, canEditChecklist: false, canApprove: false }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const adminFin = await callerFor(users["admin+fin"]);
    await adminFin.members.upsert({ projectId: fixture.projectId, userId: target.id, projectRole: "PM", canViewFinancials: true, canEditChecklist: false, canApprove: false });
    const [row] = await db().select().from(schema.projectMember).where(eq(schema.projectMember.userId, target.id));
    expect(row?.canViewFinancials).toBe(true);
  });

  it("externals can never be given checklist editing", async () => {
    const ext = await createUser("external");
    const owner = await callerFor(users.owner);
    await expect(
      owner.members.upsert({ projectId: fixture.projectId, userId: ext.id, projectRole: "Architect", canViewFinancials: false, canEditChecklist: true, canApprove: false }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
