"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { ShareLinkDialog } from "@/components/share-link";
import { ErrorState } from "@/components/ui/architecture";
import { IconArrowLeft, IconPaperclip, IconPlus } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Badge, Button, Field, Input, Panel, Select, Skeleton, StatusPill, Textarea } from "@/components/ui/primitives";
import { DOC_CATEGORIES, docCategoryLabel, VENDOR_KIND_LABEL, websiteUrl } from "@/core/directory";
import { formatIsoDate } from "@/core/time";
import { putObject, UploadError } from "@/lib/file-upload";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";
import { VendorDialog } from "../vendor-dialog";

type Data = RouterOutputs["directory"]["get"];
type Contact = Data["contacts"][number];
type Doc = Data["documents"][number];
type DocKind = keyof typeof DOC_CATEGORIES;

const KIND_TITLE: Record<DocKind, string> = { license: "Licenses", coi: "Insurance (COIs)", w9: "W-9", other: "Other documents" };
const VIA_LABEL: Record<string, string> = { commitment: "contract", invoice: "invoices", task: "tasks", coi: "COI on the expiry tracker", punch: "punch items" };
const d = (iso: string | null) => (iso ? formatIsoDate(iso, { month: "short", day: "numeric", year: "numeric" }) : "");

export function VendorView({ id }: { id: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery(trpc.directory.get.queryOptions({ id }));
  const [editing, setEditing] = useState(false);
  const [contact, setContact] = useState<Contact | "new" | null>(null);
  const [doc, setDoc] = useState<{ kind: DocKind; doc: Doc | null } | null>(null);
  const [invite, setInvite] = useState<{ name: string; url: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.directory.pathKey() });
  const archive = useMutation(trpc.directory.setArchived.mutationOptions({ onSuccess: () => refresh(), onError: (e) => toast("error", errorMessage(e)) }));
  const inviteM = useMutation(
    trpc.users.invite.mutationOptions({
      onSuccess: async (r, v) => {
        setInvite({ name: v.name, url: r.inviteUrl });
        await refresh();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );

  if (q.isPending) return <Skeleton className="h-96 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const { vendor: v, contacts, documents, projects, canEdit, canInvite } = q.data;
  const site = websiteUrl(v.website);
  const kinds: DocKind[] = canEdit ? ["license", "coi", "w9", "other"] : ["license", "coi", "other"];

  return (
    <>
      <Link href="/directory" className="mb-6 inline-flex items-center gap-2 text-[13px] text-muted hover:text-text">
        <IconArrowLeft size={16} /> Directory
      </Link>
      <header className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="eyebrow">{[VENDOR_KIND_LABEL[v.kind], v.trade].filter(Boolean).join(" · ")}</p>
          <h1 className="serif mt-2 text-title">{v.name}</h1>
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[14px] text-muted">
            {v.phone && <a href={`tel:${v.phone}`}>{v.phone}</a>}
            {v.email && <a href={`mailto:${v.email}`}>{v.email}</a>}
            {site && (
              <a href={site} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                {v.website}
              </a>
            )}
            {v.address && <span>{v.address}</span>}
          </p>
          {v.archivedAt && <StatusPill tone="neutral" className="mt-3">Archived</StatusPill>}
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" loading={archive.isPending} onClick={() => archive.mutate({ id: v.id, archived: !v.archivedAt })}>
              {v.archivedAt ? "Restore" : "Archive"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
        )}
      </header>

      <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-8">
          <Panel
            title="Licenses, insurance and W-9"
            description="Expiry dates remind the owners at 30, 14 and 7 days. A lapsed COI flags this company on every project it's on."
          >
            <div className="flex flex-col gap-6">
              {kinds.map((kind) => {
                const mine = documents.filter((x) => x.kind === kind);
                return (
                  <section key={kind}>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h3 className="eyebrow">{KIND_TITLE[kind]}</h3>
                      {canEdit && (
                        <Button size="sm" variant="ghost" onClick={() => setDoc({ kind, doc: null })}>
                          <IconPlus size={16} /> Add
                        </Button>
                      )}
                    </div>
                    {mine.length === 0 ? (
                      <p className="text-[13px] text-muted">None on file.</p>
                    ) : (
                      <ul className="divide-y divide-border rounded-panel border border-border">
                        {mine.map((x) => (
                          <li key={x.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                            <button type="button" disabled={!canEdit} onClick={() => setDoc({ kind, doc: x })} className="min-w-0 flex-1 text-left">
                              <span className="block text-[14px] font-medium">
                                {docCategoryLabel(x.kind, x.category)}
                                {x.label ? `: ${x.label}` : ""}
                              </span>
                              <span className="num block text-[12px] text-muted">
                                {[x.number && `No. ${x.number}`, x.expiresOn && `Expires ${d(x.expiresOn)}`].filter(Boolean).join(" · ") || "No number or expiry"}
                              </span>
                            </button>
                            {x.state === "expired" && <StatusPill tone="blocked">{x.lapsed ? "Lapsed" : "Expired"}</StatusPill>}
                            {x.state === "soon" && <StatusPill tone="attention">Expiring</StatusPill>}
                            {x.hasFile && (
                              <a href={`/api/media/directory/${x.id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-[13px] underline underline-offset-4">
                                <IconPaperclip size={14} /> Open
                              </a>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          </Panel>

          <Panel
            title="People"
            actions={
              canEdit && (
                <Button size="sm" variant="secondary" onClick={() => setContact("new")}>
                  <IconPlus size={16} /> Add a person
                </Button>
              )
            }
          >
            {contacts.length === 0 ? (
              <p className="text-[13px] text-muted">No one yet.</p>
            ) : (
              <ul className="-mx-6 divide-y divide-border sm:-mx-8">
                {contacts.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-3 px-6 py-3 sm:px-8">
                    <button type="button" disabled={!canEdit} onClick={() => setContact(c)} className="min-w-0 flex-1 text-left">
                      <span className="block font-medium">{c.name}</span>
                      <span className="block truncate text-[13px] text-muted">{[c.title, c.email, c.phone].filter(Boolean).join(" · ")}</span>
                    </button>
                    {c.hasAccount ? (
                      <Badge>Has an account</Badge>
                    ) : c.invited ? (
                      <Badge>Invited</Badge>
                    ) : (
                      canInvite &&
                      c.email && (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={inviteM.isPending && inviteM.variables?.email === c.email}
                          onClick={() => inviteM.mutate({ email: c.email!, name: c.name, role: "external", title: c.title ?? undefined, company: v.name.slice(0, 120) })}
                        >
                          Invite as outside collaborator
                        </Button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {v.notes && (
            <Panel title="Internal notes">
              <p className="whitespace-pre-line text-[15px] text-muted">{v.notes}</p>
            </Panel>
          )}
        </div>

        <aside className="flex flex-col gap-8">
          <Panel title="Rating">
            {v.rating != null ? (
              <p className="text-[24px] text-accent" aria-label={`Rated ${v.rating} of 5`}>
                {"★".repeat(v.rating)}
                <span className="opacity-25">{"★".repeat(5 - v.rating)}</span>
              </p>
            ) : (
              <p className="text-[13px] text-muted">Not rated.</p>
            )}
          </Panel>
          <Panel title="Projects" description="Where this company shows up on projects you can open.">
            {projects.length === 0 ? (
              <p className="text-[13px] text-muted">Not on any project yet.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {projects.map((p) => (
                  <li key={p.id}>
                    <Link href={`/projects/${p.id}`} className="font-medium underline-offset-4 hover:underline">
                      {p.name}
                    </Link>
                    <span className="block text-[12px] text-muted">{p.via.map((x) => VIA_LABEL[x] ?? x).join(", ")}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </aside>
      </div>

      {editing && <VendorDialog vendor={v} onClose={() => setEditing(false)} />}
      {contact && <ContactDialog vendorId={v.id} contact={contact === "new" ? null : contact} onClose={() => setContact(null)} />}
      {doc && <DocDialog vendorId={v.id} kind={doc.kind} doc={doc.doc} onClose={() => setDoc(null)} />}
      {invite && (
        <ShareLinkDialog
          title={`Invite ${invite.name}`}
          intro="Email is off, so send this link yourself. It works once and expires in a week."
          url={invite.url}
          whatsappText={`You're invited to Project Command: ${invite.url}`}
          onClose={() => setInvite(null)}
        />
      )}
    </>
  );
}

function ContactDialog({ vendorId, contact, onClose }: { vendorId: string; contact: Contact | null; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const done = (msg: string) => async () => {
    toast("success", msg);
    await qc.invalidateQueries({ queryKey: trpc.directory.pathKey() });
    onClose();
  };
  const save = useMutation(trpc.directory.saveContact.mutationOptions({ onSuccess: done(contact ? "Saved" : "Added"), onError: (e) => setError(errorMessage(e)) }));
  const remove = useMutation(trpc.directory.deleteContact.mutationOptions({ onSuccess: done("Removed"), onError: (e) => setError(errorMessage(e)) }));
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    save.mutate({ id: contact?.id, version: contact?.version, vendorId, name: s("name"), title: s("title") || null, email: s("email") || null, phone: s("phone") || null, notes: s("notes") || null });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={contact ? contact.name : "Add a person"}
      footer={
        <>
          {contact && (
            <Button variant="danger" className="mr-auto" onClick={() => setConfirm(true)}>
              Remove
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="contact-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="contact-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="c-name">
          <Input id="c-name" name="name" required maxLength={160} defaultValue={contact?.name ?? ""} />
        </Field>
        <Field label="Title / role" htmlFor="c-title">
          <Input id="c-title" name="title" maxLength={120} defaultValue={contact?.title ?? ""} placeholder="PM, Principal, Super…" />
        </Field>
        <Field label="Email" htmlFor="c-email">
          <Input id="c-email" name="email" type="email" maxLength={200} defaultValue={contact?.email ?? ""} />
        </Field>
        <Field label="Phone" htmlFor="c-phone">
          <Input id="c-phone" name="phone" type="tel" maxLength={40} defaultValue={contact?.phone ?? ""} />
        </Field>
        <Field label="Notes" htmlFor="c-notes" className="sm:col-span-2">
          <Textarea id="c-notes" name="notes" rows={2} maxLength={2000} defaultValue={contact?.notes ?? ""} />
        </Field>
        {error && (
          <p role="alert" className="text-[13px] text-blocked-text sm:col-span-2">
            {error}
          </p>
        )}
      </form>
      <ConfirmDialog open={confirm} title="Remove this person?" body="Their account, if they have one, isn't touched." confirmLabel="Remove" danger busy={remove.isPending} onCancel={() => setConfirm(false)} onConfirm={() => remove.mutate({ id: contact!.id })} />
    </Dialog>
  );
}

function DocDialog({ vendorId, kind, doc, onClose }: { vendorId: string; kind: DocKind; doc: Doc | null; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const save = useMutation(trpc.directory.saveDocument.mutationOptions());
  const begin = useMutation(trpc.directory.beginDocUpload.mutationOptions());
  const complete = useMutation(trpc.directory.completeDocUpload.mutationOptions());
  const remove = useMutation(
    trpc.directory.deleteDocument.mutationOptions({
      onSuccess: async () => {
        toast("success", "Removed");
        await qc.invalidateQueries({ queryKey: trpc.directory.pathKey() });
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );
  const categories = DOC_CATEGORIES[kind];
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    const file = fileRef.current?.files?.[0] ?? null;
    setBusy(true);
    setError(null);
    try {
      const { id } = await save.mutateAsync({ id: doc?.id, vendorId, kind, category: s("category") || categories[0]!.key, label: s("label") || null, number: s("number") || null, expiresOn: s("expiresOn") || null });
      if (file) {
        const b = await begin.mutateAsync({ documentId: id, name: file.name, contentType: file.type || "application/octet-stream", sizeBytes: file.size });
        for (const o of b.objects) await putObject(b.mode, b.uploadId, o.pathname, file, o.contentType, () => undefined);
        await complete.mutateAsync({ uploadId: b.uploadId });
      }
      toast("success", doc ? "Saved" : "Added");
      await qc.invalidateQueries({ queryKey: trpc.directory.pathKey() });
      onClose();
    } catch (err) {
      setError(err instanceof UploadError ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const needsExpiry = kind === "license" || kind === "coi";
  return (
    <Dialog
      open
      onClose={onClose}
      title={doc ? docCategoryLabel(doc.kind, doc.category) : `Add ${kind === "w9" ? "a W-9" : kind === "coi" ? "a COI" : kind === "license" ? "a license" : "a document"}`}
      footer={
        <>
          {doc && (
            <Button variant="danger" className="mr-auto" onClick={() => setConfirm(true)}>
              Remove
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="doc-form" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="doc-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {categories.length > 1 && (
          <Field label="Kind" htmlFor="doc-cat">
            <Select id="doc-cat" name="category" defaultValue={doc?.category ?? categories[0]!.key}>
              {categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={kind === "coi" ? "Policy number" : kind === "w9" ? "Received for tax year" : "Number"} htmlFor="doc-num">
          <Input id="doc-num" name="number" maxLength={80} defaultValue={doc?.number ?? ""} className="num" />
        </Field>
        {kind !== "w9" && (
          <Field label={needsExpiry ? "Expires" : "Expires (optional)"} htmlFor="doc-exp">
            <Input id="doc-exp" name="expiresOn" type="date" required={needsExpiry} defaultValue={doc?.expiresOn ?? ""} className="num" />
          </Field>
        )}
        <Field label="Note" htmlFor="doc-label" className={kind === "w9" ? "" : "sm:col-span-2"}>
          <Input id="doc-label" name="label" maxLength={120} defaultValue={doc?.label ?? ""} placeholder={kind === "coi" ? "Carrier, limits…" : ""} />
        </Field>
        <Field label={doc?.hasFile ? `Replace the file (${doc.originalName ?? "on file"})` : "File (PDF or photo)"} htmlFor="doc-file" className="sm:col-span-2">
          <input id="doc-file" ref={fileRef} type="file" accept="application/pdf,image/*" className="text-sm" />
        </Field>
        {kind === "w9" && <p className="text-[12px] text-muted sm:col-span-2">W-9s carry a tax ID: only owners and admins can see them.</p>}
        {error && (
          <p role="alert" className="text-[13px] text-blocked-text sm:col-span-2">
            {error}
          </p>
        )}
      </form>
      <ConfirmDialog open={confirm} title="Remove this document?" body="The file is deleted too." confirmLabel="Remove" danger busy={remove.isPending} onCancel={() => setConfirm(false)} onConfirm={() => remove.mutate({ id: doc!.id })} />
    </Dialog>
  );
}
