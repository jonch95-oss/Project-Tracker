/**
 * Notification rules (brief §9): which event goes to which channel, quiet
 * hours, overdue nudges, and text that is safe to show outside the app
 * (push, email subjects, WhatsApp). Pure.
 */
import { daysBetween } from "./time";

/** In-app is always on: the Inbox is the record of everything. People tune push and email. */
export type Channel = "push" | "email";

/** Events people can tune, with the channels on by default. Email is rationed (brief §3): only these few. */
export const NOTIFY_EVENTS = [
  { kind: "assigned", label: "Assigned to me", email: false },
  { kind: "due_tomorrow", label: "Due tomorrow", email: false },
  { kind: "overdue", label: "Overdue reminders", email: true },
  { kind: "mention", label: "@mentions", email: false },
  { kind: "comment", label: "Comments on my tasks", email: false },
  { kind: "approval_requested", label: "Approval requested", email: true },
  { kind: "approval_decided", label: "Approval decided", email: false },
  { kind: "unblocked", label: "A task I'm waiting on is done", email: false },
  { kind: "follow_up", label: "Follow up with third parties", email: false },
  { kind: "key_date", label: "Key dates approaching", email: false },
  { kind: "record_change", label: "Public-record changes", email: false },
  { kind: "file_added", label: "Files added to folders I watch", email: false },
  { kind: "digest", label: "Daily digest (7:00am)", email: true },
] as const;
export type NotifyKind = (typeof NOTIFY_EVENTS)[number]["kind"] | "system";

export type Prefs = Record<string, { push?: boolean; email?: boolean }>;

/** Is this channel on for this event? Missing = the default (push on; email only where the brief sends it). */
export function channelOn(prefs: Prefs | null | undefined, kind: string, channel: Channel): boolean {
  const set = prefs?.[kind]?.[channel];
  if (set !== undefined) return set;
  if (channel === "email") return NOTIFY_EVENTS.find((e) => e.kind === kind)?.email ?? false;
  return true;
}

const toMin = (hhmm: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export function isHHMM(v: string): boolean {
  const m = toMin(v);
  return m !== null && m < 24 * 60;
}

/** Within quiet hours? Handles windows that cross midnight (e.g. 21:00–07:00). */
export function inQuietHours(minuteOfDay: number, start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const s = toMin(start);
  const e = toMin(end);
  if (s === null || e === null || s === e) return false;
  return s < e ? minuteOfDay >= s && minuteOfDay < e : minuteOfDay >= s || minuteOfDay < e;
}

/**
 * Text for push, email subjects and WhatsApp: never a dollar figure (brief
 * §9). Amounts like "$1,250,000", "$1.2M" or "$850K" become "an amount".
 */
export function safeOutsideText(s: string): string {
  return s.replace(/-?\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:[KMB]|thousand|million|billion)\b)?/gi, "an amount").replace(/\(\s*an amount\s*\)/g, "an amount");
}

/** A WhatsApp link that opens the person's own WhatsApp with the message ready (they press send). */
export function whatsappUrl(text: string, link?: string): string {
  const body = safeOutsideText(link ? `${text}\n${link}` : text);
  return `https://wa.me/?text=${encodeURIComponent(body)}`;
}

export interface NudgeState {
  dueOn: string | null;
  status: string;
  nudgeCount: number;
  nudgedForDue: string | null;
  lastNudgedOn: string | null;
}

/**
 * Overdue nudge (brief §9): every 2 days to the assignee until done or
 * re-dated; the third nudge copies the project owner. Re-dating restarts the
 * count. Returns the nudge to send today, or null.
 */
export function overdueNudge(t: NudgeState, today: string): { count: number; copyOwner: boolean } | null {
  if (!t.dueOn || t.status === "done" || t.dueOn >= today) return null;
  const sameDue = t.nudgedForDue === t.dueOn;
  const count = sameDue ? t.nudgeCount : 0;
  if (sameDue && t.lastNudgedOn && daysBetween(t.lastNudgedOn, today) < 2) return null;
  const next = count + 1;
  return { count: next, copyOwner: next === 3 };
}
