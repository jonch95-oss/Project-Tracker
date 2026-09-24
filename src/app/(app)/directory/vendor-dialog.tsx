"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { VENDOR_KIND_LABEL } from "@/core/directory";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";

type Vendor = RouterOutputs["directory"]["get"]["vendor"];

export function VendorDialog({ vendor, onClose, onSaved }: { vendor: Vendor | null; onClose: () => void; onSaved?: (id: string) => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [rating, setRating] = useState<number | null>(vendor?.rating ?? null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation(
    trpc.directory.saveVendor.mutationOptions({
      onSuccess: async (r) => {
        toast("success", vendor ? "Saved" : "Added to the directory");
        await qc.invalidateQueries({ queryKey: trpc.directory.pathKey() });
        onClose();
        onSaved?.(r.id);
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    save.mutate({
      id: vendor?.id,
      version: vendor?.version,
      name: s("name"),
      kind: s("kind") as never,
      trade: s("trade") || null,
      phone: s("phone") || null,
      email: s("email") || null,
      website: s("website") || null,
      address: s("address") || null,
      rating,
      notes: s("notes") || null,
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={vendor ? vendor.name : "Add a company"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="vendor-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="vendor-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Company name" htmlFor="v-name" className="sm:col-span-2">
          <Input id="v-name" name="name" required maxLength={160} defaultValue={vendor?.name ?? ""} placeholder="e.g. Brick & Beam Builders LLC" />
        </Field>
        <Field label="Kind" htmlFor="v-kind">
          <Select id="v-kind" name="kind" defaultValue={vendor?.kind ?? "contractor"}>
            {Object.entries(VENDOR_KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Trade / role" htmlFor="v-trade">
          <Input id="v-trade" name="trade" maxLength={80} defaultValue={vendor?.trade ?? ""} placeholder="GC, Electrical, Architect…" />
        </Field>
        <Field label="Phone" htmlFor="v-phone">
          <Input id="v-phone" name="phone" type="tel" maxLength={40} defaultValue={vendor?.phone ?? ""} />
        </Field>
        <Field label="Email" htmlFor="v-email">
          <Input id="v-email" name="email" type="email" maxLength={200} defaultValue={vendor?.email ?? ""} />
        </Field>
        <Field label="Website" htmlFor="v-web">
          <Input id="v-web" name="website" maxLength={200} defaultValue={vendor?.website ?? ""} placeholder="example.com" />
        </Field>
        <Field label="Address" htmlFor="v-addr">
          <Input id="v-addr" name="address" maxLength={300} defaultValue={vendor?.address ?? ""} />
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-[13px] font-medium">Internal rating</legend>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`${n} of 5`}
                aria-pressed={rating === n}
                onClick={() => setRating(rating === n ? null : n)}
                className={`size-10 rounded-control text-[20px] ${rating != null && n <= rating ? "text-accent" : "text-faint"} hover:bg-sunken`}
              >
                ★
              </button>
            ))}
            {rating != null && <span className="ml-2 text-[13px] text-muted">Tap again to clear</span>}
          </div>
        </fieldset>
        <Field label="Internal notes" htmlFor="v-notes" className="sm:col-span-2" hint="Only your team sees the rating and notes.">
          <Textarea id="v-notes" name="notes" rows={3} maxLength={4000} defaultValue={vendor?.notes ?? ""} />
        </Field>
        {error && (
          <p role="alert" className="text-[13px] text-blocked-text sm:col-span-2">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
