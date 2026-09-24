import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { canProject } from "@/core/permissions";
import { docState, isValidDocCategory, lapsedCoiKinds } from "@/core/directory";
import { vendorKey } from "@/core/expiries";
import { cleanDisplayName, fileExtension, normalizeContentType, previewKind, storedContentType } from "@/core/files";
import { safeFileName } from "@/core/images";
import { todayET } from "@/core/time";
import { schema, type DbOrTx } from "../../db";
import { VENDOR_DOC_KINDS, VENDOR_KINDS } from "../../db/schema/app";
import { recordAudit } from "../../services/audit";
import { vendorProjects, type VendorLink } from "../../services/directory";
import { assertUploadBudget, claimUpload, createPendingUpload, deleteStoredObjects, meterStored, openUpload, verifyUploadedObjects } from "../../services/uploads";
import { storage } from "../../storage";
import { planDate } from "../dates";
import { globalProcedure, router, type AuthedContext } from "../init";

const MAX_DOC_BYTES = 25 * 1024 * 1024;
const text = (max: number) => z.string().trim().max(max);
const conflict = () => new TRPCError({ code: "CONFLICT", message: "Someone else just changed this. Reload to see the latest." });
const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "Not found" });
const isEditor = (ctx: AuthedContext) => ctx.actor.role === "owner" || ctx.actor.role === "admin";

async function audit(tx: DbOrTx, ctx: AuthedContext, action: "create" | "update" | "delete", entityType: string, entityId: string, summary: string) {
  await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action, entityType, entityId, summary, ip: ctx.ip });
}

/** Projects the viewer may open (owners: all), to scope "the projects they are on". */
async function viewableProjects(ctx: AuthedContext): Promise<{ id: string; name: string; financial: boolean }[]> {
  if (ctx.actor.role === "owner") {
    return (await ctx.db.select({ id: schema.project.id, name: schema.project.name }).from(schema.project).where(isNull(schema.project.archivedAt))).map((p) => ({ ...p, financial: true }));
  }
  const rows = await ctx.db
    .select({ id: schema.project.id, name: schema.project.name, m: schema.projectMember })
    .from(schema.projectMember)
    .innerJoin(schema.project, eq(schema.project.id, schema.projectMember.projectId))
    .where(and(eq(schema.projectMember.userId, ctx.viewer.id), isNull(schema.project.archivedAt)));
  return rows.map((r) => ({ id: r.id, name: r.name, financial: canProject(ctx.actor, r.m, "financials.view") }));
}

/** Contracts and invoices are financial links: they only count where the viewer sees financials. */
function visibleLinks(links: Set<VendorLink>, financial: boolean): VendorLink[] {
  return [...links].filter((l) => financial || (l !== "commitment" && l !== "invoice"));
}

const vendorFields = z.object({
  name: text(160).min(1),
  kind: z.enum(VENDOR_KINDS),
  trade: text(80).nullish(),
  phone: text(40).nullish(),
  email: z.union([z.email().max(200), z.literal("")]).nullish(),
  website: text(200).nullish(),
  address: text(300).nullish(),
  rating: z.number().int().min(1).max(5).nullish(),
  notes: text(4000).nullish(),
});

const contactFields = z.object({
  vendorId: z.uuid().nullish(),
  name: text(160).min(1),
  title: text(120).nullish(),
  email: z.union([z.email().max(200), z.literal("")]).nullish(),
  phone: text(40).nullish(),
  notes: text(2000).nullish(),
});

const docFields = z.object({
  vendorId: z.uuid(),
  kind: z.enum(VENDOR_DOC_KINDS),
  category: text(40).min(1),
  label: text(120).nullish(),
  number: text(80).nullish(),
  expiresOn: planDate.nullish(),
});

export const directoryRouter = router({
  /** Every company with its trade, rating, projects and paperwork standing. */
  list: globalProcedure("directory.view")
    .input(z.object({ q: z.string().trim().max(100).optional(), kind: z.enum(VENDOR_KINDS).optional(), archived: z.boolean().default(false) }).default({ archived: false }))
    .query(async ({ ctx, input }) => {
      const today = todayET();
      const q = input.q ? `%${input.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
      const vendors = await ctx.db
        .select()
        .from(schema.vendor)
        .where(and(input.archived ? sql`${schema.vendor.archivedAt} is not null` : isNull(schema.vendor.archivedAt), input.kind ? eq(schema.vendor.kind, input.kind) : undefined, q ? or(ilike(schema.vendor.name, q), ilike(schema.vendor.trade, q)) : undefined))
        .orderBy(asc(schema.vendor.name))
        .limit(500);
      const ids = vendors.map((v) => v.id);
      const docs = ids.length ? await ctx.db.select({ vendorId: schema.vendorDocument.vendorId, kind: schema.vendorDocument.kind, category: schema.vendorDocument.category, expiresOn: schema.vendorDocument.expiresOn }).from(schema.vendorDocument).where(inArray(schema.vendorDocument.vendorId, ids)) : [];
      const contacts = ids.length ? await ctx.db.select({ vendorId: schema.contact.vendorId, n: sql<number>`count(*)::int` }).from(schema.contact).where(inArray(schema.contact.vendorId, ids)).groupBy(schema.contact.vendorId) : [];
      const projects = await viewableProjects(ctx);
      const links = await vendorProjects(ctx.db, vendors, projects.map((p) => p.id));
      const fin = new Map(projects.map((p) => [p.id, p.financial]));
      return {
        vendors: vendors.map((v) => {
          const mine = docs.filter((d) => d.vendorId === v.id);
          const onProjects = [...(links.get(v.id) ?? new Map())].filter(([pid, l]) => visibleLinks(l, fin.get(pid) ?? false).length > 0).length;
          const latestPerKind = new Map<string, string>();
          for (const d of mine) if (d.expiresOn && (d.kind === "license" || d.kind === "coi")) latestPerKind.set(`${d.kind}|${d.category}`, [latestPerKind.get(`${d.kind}|${d.category}`) ?? "", d.expiresOn].sort().at(-1)!);
          const states = [...latestPerKind.values()].map((on) => docState(on, today));
          return {
            id: v.id,
            name: v.name,
            kind: v.kind,
            trade: v.trade,
            phone: v.phone,
            email: v.email,
            rating: v.rating,
            contacts: contacts.find((c) => c.vendorId === v.id)?.n ?? 0,
            projects: onProjects,
            lapsedCoi: lapsedCoiKinds(mine, today).length > 0,
            expired: states.filter((s) => s === "expired").length,
            expiringSoon: states.filter((s) => s === "soon").length,
            hasW9: mine.some((d) => d.kind === "w9"),
          };
        }),
        canEdit: isEditor(ctx),
      };
    }),

  /** Pickers (task vendor, etc.): active companies by name. */
  options: globalProcedure("directory.view").query(async ({ ctx }) => {
    return ctx.db.select({ id: schema.vendor.id, name: schema.vendor.name, trade: schema.vendor.trade }).from(schema.vendor).where(isNull(schema.vendor.archivedAt)).orderBy(asc(schema.vendor.name)).limit(1000);
  }),

  get: globalProcedure("directory.view")
    .input(z.object({ id: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const today = todayET();
      const [v] = await ctx.db.select().from(schema.vendor).where(eq(schema.vendor.id, input.id));
      if (!v) throw notFound();
      const editor = isEditor(ctx);
      const contacts = await ctx.db
        .select({ c: schema.contact, userId: schema.user.id, userRole: schema.user.role, userStatus: schema.user.status })
        .from(schema.contact)
        .leftJoin(schema.user, sql`lower(${schema.user.email}) = lower(${schema.contact.email})`)
        .where(eq(schema.contact.vendorId, v.id))
        .orderBy(asc(schema.contact.name));
      const invites = contacts.some((c) => c.c.email && !c.userId)
        ? await ctx.db
            .select({ email: schema.invitation.email })
            .from(schema.invitation)
            .where(and(inArray(sql`lower(${schema.invitation.email})`, contacts.flatMap((c) => (c.c.email ? [c.c.email.toLowerCase()] : []))), isNull(schema.invitation.acceptedAt), isNull(schema.invitation.revokedAt), sql`${schema.invitation.expiresAt} > now()`))
        : [];
      const docs = await ctx.db.select().from(schema.vendorDocument).where(eq(schema.vendorDocument.vendorId, v.id)).orderBy(asc(schema.vendorDocument.kind), sql`${schema.vendorDocument.expiresOn} desc nulls last`);
      const projects = await viewableProjects(ctx);
      const links = (await vendorProjects(ctx.db, [v], projects.map((p) => p.id))).get(v.id) ?? new Map();
      const lapsed = new Set(lapsedCoiKinds(docs, today));
      return {
        vendor: v,
        contacts: contacts.map((c) => ({ ...c.c, hasAccount: !!c.userId && c.userStatus === "active", invited: !c.userId && !!c.c.email && invites.some((i) => i.email.toLowerCase() === c.c.email!.toLowerCase()) })),
        // W-9s carry a tax ID: only owners and admins see them at all.
        documents: docs
          .filter((d) => d.kind !== "w9" || editor)
          .map((d) => ({ id: d.id, kind: d.kind, category: d.category, label: d.label, number: d.number, expiresOn: d.expiresOn, state: docState(d.expiresOn, today), hasFile: !!d.objectKey, originalName: d.originalName, lapsed: d.kind === "coi" && lapsed.has(d.category) })),
        projects: projects
          .filter((p) => links.has(p.id))
          .map((p) => ({ id: p.id, name: p.name, via: visibleLinks(links.get(p.id)!, p.financial) }))
          .filter((p) => p.via.length > 0),
        canEdit: editor,
        canInvite: ctx.actor.role === "owner",
      };
    }),

  saveVendor: globalProcedure("directory.edit")
    .input(vendorFields.extend({ id: z.uuid().optional(), version: z.number().int().min(1).optional() }))
    .mutation(async ({ ctx, input }) => {
      const key = vendorKey(input.name);
      if (!key) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the company a name." });
      return ctx.db.transaction(async (tx) => {
        const [clash] = await tx.select({ id: schema.vendor.id, name: schema.vendor.name }).from(schema.vendor).where(and(eq(schema.vendor.key, key), input.id ? sql`${schema.vendor.id} <> ${input.id}` : undefined));
        if (clash) throw new TRPCError({ code: "CONFLICT", message: `${clash.name} is already in the directory.` });
        const values = { name: input.name, key, kind: input.kind, trade: input.trade || null, phone: input.phone || null, email: input.email || null, website: input.website || null, address: input.address || null, rating: input.rating ?? null, notes: input.notes || null };
        if (input.id) {
          const [row] = await tx
            .update(schema.vendor)
            .set({ ...values, version: sql`${schema.vendor.version} + 1`, updatedAt: new Date() })
            .where(and(eq(schema.vendor.id, input.id), eq(schema.vendor.version, input.version ?? 0)))
            .returning({ id: schema.vendor.id });
          if (!row) throw conflict();
          await audit(tx, ctx, "update", "vendor", row.id, `${ctx.viewer.name} updated ${input.name} in the directory`);
          return { id: row.id };
        }
        const [row] = await tx.insert(schema.vendor).values({ ...values, createdById: ctx.viewer.id }).returning({ id: schema.vendor.id });
        // Contracts and invoices already typed under this name link up now.
        await relinkByName(tx, row!.id, key);
        await audit(tx, ctx, "create", "vendor", row!.id, `${ctx.viewer.name} added ${input.name} to the directory`);
        return { id: row!.id };
      });
    }),

  setArchived: globalProcedure("directory.edit")
    .input(z.object({ id: z.uuid(), archived: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db.update(schema.vendor).set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() }).where(eq(schema.vendor.id, input.id)).returning({ id: schema.vendor.id, name: schema.vendor.name });
      if (!row) throw notFound();
      await audit(ctx.db, ctx, "update", "vendor", row.id, `${ctx.viewer.name} ${input.archived ? "archived" : "restored"} ${row.name}`);
      return { ok: true };
    }),

  saveContact: globalProcedure("directory.edit")
    .input(contactFields.extend({ id: z.uuid().optional(), version: z.number().int().min(1).optional() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        if (input.vendorId) {
          const [v] = await tx.select({ id: schema.vendor.id }).from(schema.vendor).where(eq(schema.vendor.id, input.vendorId));
          if (!v) throw notFound();
        }
        const values = { vendorId: input.vendorId ?? null, name: input.name, title: input.title || null, email: input.email ? input.email.toLowerCase() : null, phone: input.phone || null, notes: input.notes || null };
        if (input.id) {
          const [row] = await tx
            .update(schema.contact)
            .set({ ...values, version: sql`${schema.contact.version} + 1`, updatedAt: new Date() })
            .where(and(eq(schema.contact.id, input.id), eq(schema.contact.version, input.version ?? 0)))
            .returning({ id: schema.contact.id });
          if (!row) throw conflict();
          await audit(tx, ctx, "update", "contact", row.id, `${ctx.viewer.name} updated contact ${input.name}`);
          return { id: row.id };
        }
        const [row] = await tx.insert(schema.contact).values(values).returning({ id: schema.contact.id });
        await audit(tx, ctx, "create", "contact", row!.id, `${ctx.viewer.name} added contact ${input.name}`);
        return { id: row!.id };
      });
    }),

  deleteContact: globalProcedure("directory.edit")
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db.delete(schema.contact).where(eq(schema.contact.id, input.id)).returning({ id: schema.contact.id, name: schema.contact.name });
      if (!row) throw notFound();
      await audit(ctx.db, ctx, "delete", "contact", row.id, `${ctx.viewer.name} removed contact ${row.name}`);
      return { ok: true };
    }),

  /** A license, COI, W-9 or other paper; the file itself is attached with begin/completeDocUpload. */
  saveDocument: globalProcedure("directory.edit")
    .input(docFields.extend({ id: z.uuid().optional() }))
    .mutation(async ({ ctx, input }) => {
      if (!isValidDocCategory(input.kind, input.category)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick what kind of document this is." });
      if ((input.kind === "license" || input.kind === "coi") && !input.expiresOn) throw new TRPCError({ code: "BAD_REQUEST", message: "Licenses and COIs need an expiry date." });
      return ctx.db.transaction(async (tx) => {
        const [v] = await tx.select({ id: schema.vendor.id, name: schema.vendor.name }).from(schema.vendor).where(eq(schema.vendor.id, input.vendorId));
        if (!v) throw notFound();
        const values = { kind: input.kind, category: input.category, label: input.label || null, number: input.number || null, expiresOn: input.expiresOn ?? null };
        if (input.id) {
          const [row] = await tx.update(schema.vendorDocument).set(values).where(and(eq(schema.vendorDocument.id, input.id), eq(schema.vendorDocument.vendorId, v.id))).returning({ id: schema.vendorDocument.id });
          if (!row) throw notFound();
          await audit(tx, ctx, "update", "vendor_document", row.id, `${ctx.viewer.name} updated a ${input.kind.toUpperCase()} for ${v.name}`);
          return { id: row.id };
        }
        const [row] = await tx.insert(schema.vendorDocument).values({ ...values, vendorId: v.id, uploadedById: ctx.viewer.id }).returning({ id: schema.vendorDocument.id });
        await audit(tx, ctx, "create", "vendor_document", row!.id, `${ctx.viewer.name} added a ${input.kind === "w9" ? "W-9" : input.kind.toUpperCase()} for ${v.name}`);
        return { id: row!.id };
      });
    }),

  deleteDocument: globalProcedure("directory.edit")
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db.delete(schema.vendorDocument).where(eq(schema.vendorDocument.id, input.id)).returning();
      if (!row) throw notFound();
      if (row.objectKey) await deleteStoredObjects([row.objectKey], row.sizeBytes ?? 0).catch(() => undefined);
      await audit(ctx.db, ctx, "delete", "vendor_document", row.id, `${ctx.viewer.name} removed a directory document`);
      return { ok: true };
    }),

  /** Step 1 of attaching a file to a document: PDFs and images only, 25 MB at most. */
  beginDocUpload: globalProcedure("directory.edit")
    .input(z.object({ documentId: z.uuid(), name: z.string().trim().min(1).max(200), contentType: z.string().max(255), sizeBytes: z.number().int().min(1).max(MAX_DOC_BYTES) }))
    .mutation(async ({ ctx, input }) => {
      const [d] = await ctx.db.select({ id: schema.vendorDocument.id, vendorId: schema.vendorDocument.vendorId }).from(schema.vendorDocument).where(eq(schema.vendorDocument.id, input.documentId));
      if (!d) throw notFound();
      const contentType = storedContentType(normalizeContentType(input.contentType));
      if (previewKind(contentType) === "none") throw new TRPCError({ code: "BAD_REQUEST", message: "Attach a PDF or a photo of the document." });
      await assertUploadBudget(input.sizeBytes, ctx.db);
      const name = cleanDisplayName(input.name);
      const ext = fileExtension(name);
      const base = safeFileName(ext ? name.slice(0, -(ext.length + 1)) : name, "document");
      const pathname = `directory/${d.vendorId}/${randomUUID()}/${ext ? `${base}.${ext}` : base}`;
      const row = await createPendingUpload(ctx.db, { userId: ctx.viewer.id, projectId: null, purpose: "directory", objects: [{ role: "file", pathname, maxBytes: input.sizeBytes, contentType }], meta: { documentId: d.id, name } });
      return { uploadId: row.id, mode: storage().name === "vercel-blob" ? ("blob" as const) : ("local" as const), objects: row.objects.map((o) => ({ role: o.role, pathname: o.pathname, contentType: o.contentType })) };
    }),

  completeDocUpload: globalProcedure("directory.edit")
    .input(z.object({ uploadId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await openUpload(ctx.db, input.uploadId, ctx.viewer.id);
      if (!row || row.purpose !== "directory") throw new TRPCError({ code: "NOT_FOUND", message: "This upload has expired. Try again." });
      const meta = row.meta as { documentId: string; name: string };
      const objs = await verifyUploadedObjects(row);
      const file = objs.file!;
      const old = await ctx.db.transaction(async (tx) => {
        if (!(await claimUpload(tx, row.id, ctx.viewer.id))) throw new TRPCError({ code: "NOT_FOUND", message: "This upload has already been saved or has expired." });
        const [before] = await tx.select().from(schema.vendorDocument).where(eq(schema.vendorDocument.id, meta.documentId)).for("update");
        if (!before) throw notFound();
        await tx.update(schema.vendorDocument).set({ objectKey: file.pathname, originalName: meta.name, contentType: file.contentType, sizeBytes: file.size }).where(eq(schema.vendorDocument.id, before.id));
        await audit(tx, ctx, "update", "vendor_document", before.id, `${ctx.viewer.name} attached ${meta.name} to a directory document`);
        return before;
      });
      await meterStored(file.size);
      // A replaced file goes from storage too.
      if (old.objectKey && old.objectKey !== file.pathname) await deleteStoredObjects([old.objectKey], old.sizeBytes ?? 0).catch(() => undefined);
      return { ok: true };
    }),
});

/** A new directory company picks up contracts and invoices already typed under its name. */
async function relinkByName(tx: DbOrTx, vendorId: string, key: string) {
  for (const t of [schema.commitment, schema.invoice] as const) {
    const rows = await tx.select({ id: t.id, name: t.vendorName }).from(t).where(isNull(t.vendorId));
    const ids = rows.filter((r) => vendorKey(r.name) === key).map((r) => r.id);
    if (ids.length) await tx.update(t).set({ vendorId }).where(inArray(t.id, ids));
  }
}
