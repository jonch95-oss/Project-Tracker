"use client";

import { useState } from "react";
import { AddressPlaceholder, EmptyState, ErrorState } from "@/components/ui/architecture";
import * as Icons from "@/components/ui/icons";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Avatar, Badge, Button, Field, Input, Kbd, Meter, PageHeader, Panel, Select, Skeleton, StatusPill, Switch, Textarea } from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/tabs";

const SWATCHES = [
  ["Limestone", "--limestone"],
  ["Paper", "--paper"],
  ["Travertine", "--travertine"],
  ["Ink", "--ink"],
  ["Secondary", "--ink-secondary"],
  ["Bronze", "--bronze"],
  ["Sage", "--sage"],
  ["Ochre", "--ochre"],
  ["Oxblood", "--oxblood"],
] as const;

/** Living reference for the component kit, in light and dark. */
export function DesignKit() {
  const [tab, setTab] = useState<"a" | "b" | "c">("a");
  const [on, setOn] = useState(true);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  return (
    <>
      <PageHeader eyebrow="System" title="Design system" description="Tokens and components. Warm neutrals, hairlines, photography first." />
      <div className="flex flex-col gap-8">
        <Panel title="Palette">
          <ul className="grid grid-cols-3 gap-4 sm:grid-cols-5 lg:grid-cols-9">
            {SWATCHES.map(([name, v]) => (
              <li key={v}>
                <div className="aspect-square rounded-panel border border-border" style={{ background: `var(${v})` }} />
                <p className="mt-2 text-[12px] font-medium">{name}</p>
                <p className="font-mono text-[11px] text-muted">{v}</p>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Type">
          <p className="serif text-[56px] leading-[60px]">412 Sterling Place</p>
          <p className="serif mt-2 text-heading">Design &amp; Zoning</p>
          <p className="mt-4 text-[15px]">Geist for interface and data. Numbers are tabular: <span className="num">$4,250,000.00 · 03/14/2026 · 118 tasks</span></p>
          <p className="eyebrow mt-4">Eyebrow label</p>
        </Panel>
        <Panel title="Buttons & status">
          <div className="flex flex-wrap gap-3">
            <Button>Primary</Button>
            <Button variant="accent">Accent</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button loading>Saving</Button>
            <Button size="sm">Small</Button>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <StatusPill tone="done">Done</StatusPill>
            <StatusPill tone="attention">Waiting on third party</StatusPill>
            <StatusPill tone="blocked">Blocked</StatusPill>
            <StatusPill tone="neutral">Not started</StatusPill>
            <StatusPill tone="accent">Awaiting approval</StatusPill>
            <Badge>Ground-up</Badge>
            <Avatar name="Jon Chen" />
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </div>
        </Panel>
        <Panel title="Forms">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Text" htmlFor="dk-1" hint="Helper text">
              <Input id="dk-1" placeholder="Placeholder" />
            </Field>
            <Field label="Select" htmlFor="dk-2">
              <Select id="dk-2">
                <option>Brooklyn</option>
              </Select>
            </Field>
            <Field label="With error" htmlFor="dk-3" error="BBL is 10 digits">
              <Input id="dk-3" aria-invalid defaultValue="301137" />
            </Field>
            <Field label="Textarea" htmlFor="dk-4">
              <Textarea id="dk-4" />
            </Field>
            <Switch id="dk-5" label="Can view financials" description="Per project" checked={on} onChange={setOn} />
          </div>
        </Panel>
        <Panel title="Navigation, overlays, feedback">
          <Tabs value={tab} onChange={setTab} items={[{ key: "a", label: "Overview" }, { key: "b", label: "Checklist" }, { key: "c", label: "Team" }]} />
          <div className="mt-6 flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => setOpen(true)}>
              Open dialog
            </Button>
            <Button variant="secondary" onClick={() => toast("success", "Saved")}>
              Success toast
            </Button>
            <Button variant="secondary" onClick={() => toast("error", "Couldn't save")}>
              Error toast
            </Button>
          </div>
          <div className="mt-6 max-w-sm space-y-3">
            <Meter valueBps={4200} tone="done" label="Example" />
            <Meter valueBps={7600} tone="attention" label="Example" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <div className="mt-6 flex flex-wrap gap-3 text-muted">
            {Object.entries(Icons).map(([name, I]) => (
              <span key={name} title={name}>
                <I size={22} />
              </span>
            ))}
          </div>
          <Dialog open={open} onClose={() => setOpen(false)} title="Dialog" description="Native dialog: focus trapped, Esc closes." footer={<Button onClick={() => setOpen(false)}>Done</Button>}>
            <p className="text-sm text-muted">Content.</p>
          </Dialog>
        </Panel>
        <div className="grid gap-6 sm:grid-cols-2">
          <AddressPlaceholder address="412 Sterling Place" borough="Brooklyn" className="aspect-[4/5] rounded-card border border-border" />
          <div className="flex flex-col gap-6">
            <EmptyState title="Empty state" body="One line of guidance and an action." />
            <ErrorState onRetry={() => {}} />
          </div>
        </div>
      </div>
    </>
  );
}
