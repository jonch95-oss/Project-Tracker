import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  cleanDisplayName,
  fileExtension,
  normalizeContentType,
  storedContentType,
} from "@/core/files";
import { safeFileName } from "@/core/images";
import {
  emailAddressOf,
  INBOX_FOLDER,
  inboundKeyFor,
  inboundKeyFromRecipient,
  MAX_INBOUND_ATTACHMENT_BYTES,
  MAX_INBOUND_ATTACHMENTS,
  type InboundMessage,
} from "@/core/inbound";
import { canProject, isInternalRole } from "@/core/permissions";
import { schema, type Database, type DbOrTx } from "../db";
import { env } from "../env";
import { storage } from "../storage";
import { recordAudit } from "./audit";
import { quotaDay } from "./email";
import { ensureProjectFolders } from "./files";
import {
  assertUploadBudget,
  deleteStoredObjects,
  filePath,
  meterStored,
} from "./uploads";

/** Both settings present: the inbound address works. */
export function inboundEnabled(): boolean {
  const e = env();
  return !!(e.INBOUND_EMAIL_DOMAIN && e.INBOUND_EMAIL_SECRET);
}

/** A project's inbound address, creating its key on first use; null when the feature is off. */
export async function inboundAddress(
  conn: DbOrTx,
  projectId: string,
): Promise<string | null> {
  const domain = env().INBOUND_EMAIL_DOMAIN;
  if (!domain || !env().INBOUND_EMAIL_SECRET) return null;
  const [p] = await conn
    .select({
      key: schema.project.inboundKey,
      address: schema.project.address,
      name: schema.project.name,
    })
    .from(schema.project)
    .where(eq(schema.project.id, projectId));
  if (!p) return null;
  if (p.key) return `${p.key}@${domain}`;
  for (let i = 0; i < 5; i++) {
    const key = inboundKeyFor(p.address, p.name, randomBytes(4));
    const set = await conn
      .update(schema.project)
      .set({ inboundKey: key })
      .where(
        and(
          eq(schema.project.id, projectId),
          isNull(schema.project.inboundKey),
        ),
      )
      .returning({ key: schema.project.inboundKey })
      .catch((e: unknown) => {
        if (
          (e as { code?: string }).code === "23505" ||
          (e as { cause?: { code?: string } }).cause?.code === "23505"
        )
          return null;
        throw e;
      });
    if (set === null) continue; // key taken by another project: roll again
    if (set.length) return `${set[0]!.key}@${domain}`;
    // Someone else set it first.
    const [again] = await conn
      .select({ key: schema.project.inboundKey })
      .from(schema.project)
      .where(eq(schema.project.id, projectId));
    if (again?.key) return `${again.key}@${domain}`;
  }
  return null;
}

/** Inbound messages that count toward today's email budget (accepted or not, the provider received them). */
export async function inboundCountedToday(
  conn: DbOrTx,
  today = quotaDay(),
): Promise<number> {
  const [row] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.inboundEmail)
    .where(eq(schema.inboundEmail.quotaDay, today));
  return row?.n ?? 0;
}

export type InboundResult = {
  status: "accepted" | "rejected" | "duplicate";
  reason?: string;
  projectId?: string;
  files?: number;
};

type Accepted = {
  projectId: string;
  projectName: string;
  sender: { id: string; name: string };
  to: string;
};

async function route(
  conn: Database,
  msg: InboundMessage,
  domain: string,
): Promise<
  | Accepted
  | { reason: string; projectId?: string; to: string; senderId?: string }
> {
  const keys = msg.to
    .map((t) => ({ to: t, key: inboundKeyFromRecipient(t, domain) }))
    .filter((k): k is { to: string; key: string } => !!k.key);
  const to = keys[0]?.to ?? msg.to[0] ?? "";
  if (!keys.length) return { reason: "Not addressed to a project.", to };
  const [p] = await conn
    .select({
      id: schema.project.id,
      name: schema.project.name,
      key: schema.project.inboundKey,
      archivedAt: schema.project.archivedAt,
    })
    .from(schema.project)
    .where(
      sql`${schema.project.inboundKey} in (${sql.join(
        keys.map((k) => sql`${k.key}`),
        sql`, `,
      )})`,
    )
    .limit(1);
  if (!p) return { reason: "No project has this address.", to };
  const target = keys.find((k) => k.key === p.key)!.to;
  if (p.archivedAt)
    return { reason: "The project is archived.", projectId: p.id, to: target };
  const from = emailAddressOf(msg.from);
  if (!from)
    return { reason: "No sender address.", projectId: p.id, to: target };
  const [u] = await conn
    .select({
      id: schema.user.id,
      name: schema.user.name,
      role: schema.user.role,
      status: schema.user.status,
    })
    .from(schema.user)
    .where(sql`lower(${schema.user.email}) = ${from}`);
  if (!u || u.status !== "active")
    return {
      reason: "The sender isn't a registered user.",
      projectId: p.id,
      to: target,
    };
  const [m] = await conn
    .select({
      projectRole: schema.projectMember.projectRole,
      canViewFinancials: schema.projectMember.canViewFinancials,
      canEditChecklist: schema.projectMember.canEditChecklist,
      canApprove: schema.projectMember.canApprove,
    })
    .from(schema.projectMember)
    .where(
      and(
        eq(schema.projectMember.projectId, p.id),
        eq(schema.projectMember.userId, u.id),
      ),
    );
  const actor = { userId: u.id, role: u.role, status: u.status };
  // Inbox files and the Activity feed are for the internal team on the project.
  if (
    !isInternalRole(u.role) ||
    !canProject(actor, m ?? null, "folder.viewAll")
  )
    return {
      reason: "The sender isn't on this project's team.",
      projectId: p.id,
      to: target,
      senderId: u.id,
    };
  return {
    projectId: p.id,
    projectName: p.name,
    sender: { id: u.id, name: u.name },
    to: target,
  };
}

type Stored = {
  name: string;
  pathname: string;
  size: number;
  contentType: string;
};

async function storeObject(
  projectId: string,
  name: string,
  body: Uint8Array,
  contentType: string,
): Promise<Stored> {
  const display = cleanDisplayName(name);
  const ext = fileExtension(display);
  const base = safeFileName(
    ext ? display.slice(0, -(ext.length + 1)) : display,
    "file",
  );
  const { object } = filePath(projectId, ext ? `${base}.${ext}` : base);
  const type = storedContentType(normalizeContentType(contentType));
  const put = await storage().put(object, body, { contentType: type });
  return { name: display, pathname: object, size: put.size, contentType: type };
}

/**
 * Save one inbound email (brief Module I). Only mail from a registered, active
 * member of the project's internal team is accepted; everything else is
 * recorded as rejected and nothing is saved. Accepted mail becomes a text file
 * of the message plus its attachments in the project's "Inbox" folder, and an
 * entry in the Activity feed. Every message received counts toward the day's
 * email budget. A redelivered message (same provider id) is a no-op.
 */
export async function receiveInbound(
  conn: Database,
  msg: InboundMessage,
  now = new Date(),
): Promise<InboundResult> {
  const domain = env().INBOUND_EMAIL_DOMAIN;
  if (!domain) return { status: "rejected", reason: "Inbound email is off." };
  const [seen] = await conn
    .select({ status: schema.inboundEmail.status })
    .from(schema.inboundEmail)
    .where(eq(schema.inboundEmail.providerId, msg.providerId));
  if (seen) return { status: "duplicate" };
  const day = quotaDay(now);
  const base = {
    providerId: msg.providerId,
    fromAddress: msg.from.slice(0, 320),
    subject: msg.subject || null,
    quotaDay: day,
  };
  const r = await route(conn, msg, domain);
  if (!("sender" in r)) {
    await conn
      .insert(schema.inboundEmail)
      .values({
        ...base,
        toAddress: r.to.slice(0, 320),
        projectId: r.projectId ?? null,
        senderId: r.senderId ?? null,
        status: "rejected",
        reason: r.reason,
      })
      .onConflictDoNothing();
    return { status: "rejected", reason: r.reason, projectId: r.projectId };
  }

  // Store the objects first (outside the transaction), then record everything at once.
  const subject = msg.subject.trim() || "(no subject)";
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  const saved: Stored[] = [];
  const skipped: string[] = [];
  const candidates = msg.attachments.slice(0, MAX_INBOUND_ATTACHMENTS);
  for (const a of msg.attachments.slice(MAX_INBOUND_ATTACHMENTS))
    skipped.push(`${a.filename} (too many attachments)`);
  const header = [
    `From: ${msg.from}`,
    `To: ${r.to}`,
    `Date: ${now.toISOString()}`,
    `Subject: ${subject}`,
  ];
  try {
    const bodyBytes = new TextEncoder().encode(
      `${header.join("\n")}\n\n${msg.text}`,
    );
    const wanted =
      bodyBytes.length +
      candidates.reduce(
        (s, a) =>
          s +
          (a.content && a.content.length <= MAX_INBOUND_ATTACHMENT_BYTES
            ? a.content.length
            : 0),
        0,
      );
    await assertUploadBudget(wanted, conn);
    for (const a of candidates) {
      if (!a.content)
        skipped.push(`${a.filename} (not included by the mail service)`);
      else if (a.content.length > MAX_INBOUND_ATTACHMENT_BYTES)
        skipped.push(`${a.filename} (over 25 MB)`);
      else
        saved.push(
          await storeObject(r.projectId, a.filename, a.content, a.contentType),
        );
    }
    const note = skipped.length
      ? `\n\n---\nNot saved: ${skipped.join("; ")}`
      : "";
    const attachedList = saved.length
      ? `\nAttachments: ${saved.map((s) => s.name).join(", ")}`
      : "";
    const text = new TextEncoder().encode(
      `${header.join("\n")}${attachedList}\n\n${msg.text}${note}`,
    );
    const emailName =
      `Email ${stamp} - ${subject}`.replace(/[\\/]/g, "-").slice(0, 180) +
      ".txt";
    saved.unshift(
      await storeObject(r.projectId, emailName, text, "text/plain"),
    );
  } catch (e) {
    await storage()
      .delete(saved.map((s) => s.pathname))
      .catch(() => undefined);
    const reason =
      (e as { code?: string }).code === "PRECONDITION_FAILED"
        ? "File storage is nearly full."
        : "Couldn't store the message.";
    await conn
      .insert(schema.inboundEmail)
      .values({
        ...base,
        toAddress: r.to.slice(0, 320),
        projectId: r.projectId,
        senderId: r.sender.id,
        status: "rejected",
        reason,
      })
      .onConflictDoNothing();
    return { status: "rejected", reason, projectId: r.projectId };
  }

  const bytes = saved.reduce((s, x) => s + x.size, 0);
  const inserted = await conn.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.inboundEmail)
      .values({
        ...base,
        toAddress: r.to.slice(0, 320),
        projectId: r.projectId,
        senderId: r.sender.id,
        status: "accepted",
        attachments: saved.length - 1,
      })
      .onConflictDoNothing()
      .returning({ id: schema.inboundEmail.id });
    if (!row) return false; // a concurrent delivery of the same message won
    await ensureProjectFolders(tx, r.projectId, [INBOX_FOLDER]);
    const [folder] = await tx
      .select({ id: schema.folder.id })
      .from(schema.folder)
      .where(
        and(
          eq(schema.folder.projectId, r.projectId),
          sql`lower(${schema.folder.name}) = lower(${INBOX_FOLDER})`,
        ),
      );
    for (const s of saved) {
      const [f] = await tx
        .insert(schema.file)
        .values({
          projectId: r.projectId,
          folderId: folder!.id,
          name: s.name,
          createdById: r.sender.id,
        })
        .returning({ id: schema.file.id });
      await tx
        .insert(schema.fileVersion)
        .values({
          fileId: f!.id,
          number: 1,
          objectKey: s.pathname,
          originalName: s.name,
          contentType: s.contentType,
          sizeBytes: s.size,
          uploadedById: r.sender.id,
          note: "Emailed in",
        });
    }
    await recordAudit(tx, {
      actorId: r.sender.id,
      actorName: r.sender.name,
      action: "create",
      entityType: "inbound_email",
      entityId: row.id,
      projectId: r.projectId,
      summary: `${r.sender.name} emailed in "${subject}"${saved.length > 1 ? ` with ${saved.length - 1} attachment${saved.length === 2 ? "" : "s"}` : ""} (saved to ${INBOX_FOLDER})`,
      data: {
        subject,
        attachments: saved.slice(1).map((s) => s.name),
        skipped,
      },
      ip: null,
    });
    return true;
  });
  if (!inserted) {
    await deleteStoredObjects(
      saved.map((s) => s.pathname),
      0,
    );
    return { status: "duplicate" };
  }
  await meterStored(bytes);
  return { status: "accepted", projectId: r.projectId, files: saved.length };
}
