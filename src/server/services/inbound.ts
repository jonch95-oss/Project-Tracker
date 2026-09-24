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
  headerValues,
  htmlToText,
  INBOX_FOLDER,
  inboundKeyFor,
  inboundKeyFromRecipient,
  MAX_INBOUND_ATTACHMENT_BYTES,
  MAX_INBOUND_ATTACHMENTS,
  senderAuthenticated,
  type InboundAttachment,
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

const isUniqueViolation = (e: unknown) =>
  (e as { code?: string }).code === "23505" ||
  (e as { cause?: { code?: string } }).cause?.code === "23505";

/** Give the project a new random key (a fresh address); the old one stops working at once. */
async function assignKey(
  conn: DbOrTx,
  p: { id: string; address: string; name: string },
  onlyIfUnset: boolean,
): Promise<string | null> {
  for (let i = 0; i < 5; i++) {
    const key = inboundKeyFor(p.address, p.name, randomBytes(4));
    const set = await conn
      .update(schema.project)
      .set({ inboundKey: key })
      .where(
        onlyIfUnset
          ? and(eq(schema.project.id, p.id), isNull(schema.project.inboundKey))
          : eq(schema.project.id, p.id),
      )
      .returning({ key: schema.project.inboundKey })
      .catch((e: unknown) => {
        if (isUniqueViolation(e)) return null;
        throw e;
      });
    if (set === null) continue; // key taken by another project: roll again
    if (set.length) return set[0]!.key;
    // Someone else set it first.
    const [again] = await conn
      .select({ key: schema.project.inboundKey })
      .from(schema.project)
      .where(eq(schema.project.id, p.id));
    if (again?.key) return again.key;
  }
  return null;
}

async function projectForKey(conn: DbOrTx, projectId: string) {
  const [p] = await conn
    .select({
      id: schema.project.id,
      key: schema.project.inboundKey,
      address: schema.project.address,
      name: schema.project.name,
    })
    .from(schema.project)
    .where(eq(schema.project.id, projectId));
  return p ?? null;
}

/** A project's inbound address, creating its key on first use; null when the feature is off. */
export async function inboundAddress(
  conn: DbOrTx,
  projectId: string,
): Promise<string | null> {
  const domain = env().INBOUND_EMAIL_DOMAIN;
  if (!domain || !env().INBOUND_EMAIL_SECRET) return null;
  const p = await projectForKey(conn, projectId);
  if (!p) return null;
  const key = p.key ?? (await assignKey(conn, p, true));
  return key ? `${key}@${domain}` : null;
}

/** Replace a project's inbound address (e.g. after someone leaves the team); null when the feature is off. */
export async function rotateInboundAddress(
  conn: DbOrTx,
  projectId: string,
): Promise<string | null> {
  const domain = env().INBOUND_EMAIL_DOMAIN;
  if (!domain || !env().INBOUND_EMAIL_SECRET) return null;
  const p = await projectForKey(conn, projectId);
  if (!p) return null;
  const key = await assignKey(conn, p, false);
  return key ? `${key}@${domain}` : null;
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
  // A From line proves nothing on its own: the receiving server must have verified it.
  if (!senderAuthenticated(msg.authResults, from))
    return {
      reason:
        "The sender's address couldn't be verified (no DMARC or DKIM pass).",
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

/* ------------------------------------------------------------------ */
/* The full message                                                    */
/* ------------------------------------------------------------------ */

type Fetcher = (msg: InboundMessage) => Promise<InboundMessage>;
let fetcherForTests: Fetcher | null = null;
/** Tests swap the provider call for a stub (null restores it). */
export function setInboundFetcherForTests(f: Fetcher | null) {
  fetcherForTests = f;
}

const RESEND_API = "https://api.resend.com";

/**
 * The provider's `email.received` webhook may carry only the message's
 * metadata. Fetch the body, headers and attachments by the message id when
 * they're missing (needs RESEND_API_KEY). Attachments come from their
 * download links, each capped at the attachment limit.
 */
async function completeMessage(msg: InboundMessage): Promise<InboundMessage> {
  if (fetcherForTests) return fetcherForTests(msg);
  const key = env().RESEND_API_KEY;
  const needsBody = !msg.hasBody || !msg.authResults;
  const needsFiles = msg.attachments.some((a) => !a.content);
  if (!key || (!needsBody && !needsFiles)) return msg;
  const get = (path: string) =>
    fetch(`${RESEND_API}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
  let out = msg;
  if (needsBody) {
    const res = await get(
      `/emails/receiving/${encodeURIComponent(msg.providerId)}`,
    );
    if (!res.ok)
      throw new Error(`Couldn't fetch the received email (${res.status})`);
    const d = (await res.json()) as Record<string, unknown>;
    const text =
      typeof d.text === "string"
        ? d.text
        : typeof d.html === "string"
          ? htmlToText(d.html)
          : out.text;
    const auth =
      headerValues(d.headers, "authentication-results").join("; ") ||
      out.authResults;
    const listed = Array.isArray(d.attachments)
      ? (d.attachments as Record<string, unknown>[])
      : [];
    const attachments: InboundAttachment[] = out.attachments.map((a) => {
      if (a.content || a.downloadUrl) return a;
      const hit = listed.find((x) => x.filename === a.filename);
      return {
        ...a,
        downloadUrl:
          typeof hit?.download_url === "string" ? hit.download_url : null,
      };
    });
    out = {
      ...out,
      text: text.slice(0, 200_000),
      authResults: auth,
      attachments,
      hasBody: true,
    };
  }
  const attachments: InboundAttachment[] = [];
  for (const a of out.attachments) {
    if (a.content || !a.downloadUrl || !/^https:\/\//.test(a.downloadUrl)) {
      attachments.push(a);
      continue;
    }
    const res = await fetch(a.downloadUrl, {
      signal: AbortSignal.timeout(30_000),
    });
    const size = Number(res.headers.get("content-length") ?? "0");
    if (!res.ok || size > MAX_INBOUND_ATTACHMENT_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      attachments.push(a);
      continue;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    attachments.push({ ...a, content: buf.length ? buf : null });
  }
  return { ...out, attachments };
}

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

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
 * member of the project's internal team, verified by the receiving server
 * (DMARC or DKIM), is accepted; everything else is recorded as rejected and
 * nothing is saved. Accepted mail becomes a text file of the message plus its
 * attachments in the project's "Inbox" folder, and an entry in the Activity
 * feed. A redelivered message (same provider id) is a no-op. A storage or
 * database failure throws, so the provider retries later.
 */
export async function receiveInbound(
  conn: Database,
  incoming: InboundMessage,
  now = new Date(),
): Promise<InboundResult> {
  const domain = env().INBOUND_EMAIL_DOMAIN;
  if (!domain) return { status: "rejected", reason: "Inbound email is off." };
  const [seen] = await conn
    .select({ status: schema.inboundEmail.status })
    .from(schema.inboundEmail)
    .where(eq(schema.inboundEmail.providerId, incoming.providerId));
  if (seen) return { status: "duplicate" };
  const day = quotaDay(now);
  const base = {
    providerId: incoming.providerId,
    fromAddress: incoming.from.slice(0, 320),
    subject: incoming.subject || null,
    quotaDay: day,
  };
  const refuse = async (
    reason: string,
    to: string,
    projectId?: string,
    senderId?: string,
  ): Promise<InboundResult> => {
    await conn
      .insert(schema.inboundEmail)
      .values({
        ...base,
        toAddress: to.slice(0, 320),
        projectId: projectId ?? null,
        senderId: senderId ?? null,
        status: "rejected",
        reason,
      })
      .onConflictDoNothing();
    return { status: "rejected", reason, projectId };
  };

  // Cheap checks first: most junk is refused without calling the provider.
  const first = await route(
    conn,
    { ...incoming, authResults: incoming.authResults ?? "dmarc=pass" },
    domain,
  );
  if (!("sender" in first))
    return refuse(first.reason, first.to, first.projectId, first.senderId);
  const msg = await completeMessage(incoming);
  const r = await route(conn, msg, domain);
  if (!("sender" in r)) return refuse(r.reason, r.to, r.projectId, r.senderId);

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
  try {
    await assertUploadBudget(wanted, conn);
  } catch {
    return refuse(
      "File storage is nearly full.",
      r.to,
      r.projectId,
      r.sender.id,
    );
  }
  const discard = () =>
    storage()
      .delete(saved.map((s) => s.pathname))
      .catch(() => undefined);
  try {
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
    await discard();
    throw e; // storage trouble: let the provider retry
  }

  const bytes = saved.reduce((s, x) => s + x.size, 0);
  let inserted: boolean;
  try {
    inserted = await conn.transaction(async (tx) => {
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
      if (!folder) throw new Error("The Inbox folder is missing");
      for (const s of saved) {
        const [f] = await tx
          .insert(schema.file)
          .values({
            projectId: r.projectId,
            folderId: folder.id,
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
  } catch (e) {
    await discard();
    throw e;
  }
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
