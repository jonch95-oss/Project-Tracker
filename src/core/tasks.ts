/**
 * Task rules (brief §6): statuses, what one-tap "complete" does, recurrence,
 * bulk re-dating, the My Tasks sections and the Needs-you rail. Pure.
 */
import { addBusinessDays, nextBusinessDay } from "./calendar";
import { addDays, daysBetween, dayOfWeek } from "./time";

export const TASK_STATUSES = ["not_started", "in_progress", "waiting", "blocked", "awaiting_approval", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  waiting: "Waiting on third party",
  blocked: "Blocked",
  awaiting_approval: "Awaiting approval",
  done: "Done",
};

export const PRIORITIES = ["low", "normal", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

/* ------------------------------------------------------------------ */
/* One-tap complete                                                    */
/* ------------------------------------------------------------------ */

export interface CompletionFacts {
  status: TaskStatus;
  unmetDependencies: number;
  requiresApproval: boolean;
  /** Label of the required attachment, if any. */
  requiredAttachment: string | null;
  attachmentCount: number;
  /** Can the person completing it approve it themselves? */
  canApprove: boolean;
}

export type CompletionOutcome =
  | { kind: "done" }
  | { kind: "blocked"; reason: "dependencies" }
  | { kind: "needs_attachment"; label: string }
  | { kind: "needs_approval" }
  | { kind: "already_done" };

/**
 * What tapping "complete" should do. A missing prerequisite blocks; a missing
 * required attachment routes to the attach step; a task needing approval goes
 * to "Awaiting approval" unless the person can approve it (their tick is the
 * approval).
 */
export function completionOutcome(f: CompletionFacts): CompletionOutcome {
  if (f.status === "done") return { kind: "already_done" };
  if (f.unmetDependencies > 0) return { kind: "blocked", reason: "dependencies" };
  if (f.requiredAttachment && f.attachmentCount === 0) return { kind: "needs_attachment", label: f.requiredAttachment };
  if (f.requiresApproval && !f.canApprove) return { kind: "needs_approval" };
  return { kind: "done" };
}

/** Status changes a person can make directly (approval decisions and completion go through their own paths). */
export function canSetStatus(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return false;
  if (to === "done" || to === "awaiting_approval") return false;
  if (from === "awaiting_approval") return to === "in_progress"; // withdraw the request
  return true;
}

/* ------------------------------------------------------------------ */
/* Recurrence                                                          */
/* ------------------------------------------------------------------ */

export type RecurrenceFreq = "weekly" | "biweekly" | "monthly";

/** The next due date after completing a recurring task, rolled to a business day. */
export function nextOccurrence(dueOn: string, freq: RecurrenceFreq, completedOn: string): string {
  const step = (d: string) => {
    if (freq === "weekly") return addDays(d, 7);
    if (freq === "biweekly") return addDays(d, 14);
    const [y, m, day] = d.split("-").map(Number) as [number, number, number];
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
  };
  // Skip past occurrences so a late completion doesn't leave the next one already overdue.
  let next = step(dueOn);
  while (next <= completedOn) next = step(next);
  return nextBusinessDay(next);
}

/* ------------------------------------------------------------------ */
/* Bulk re-dating                                                      */
/* ------------------------------------------------------------------ */

/** Move a due date by N days (negative moves it earlier); calendar results land on a business day. */
export function shiftDate(date: string, days: number, unit: "business" | "calendar"): string {
  return unit === "business" ? addBusinessDays(date, days) : nextBusinessDay(addDays(date, days));
}

/* ------------------------------------------------------------------ */
/* My Tasks                                                            */
/* ------------------------------------------------------------------ */

export const MY_TASK_SECTIONS = ["overdue", "today", "week", "later", "waiting", "approve"] as const;
export type MyTaskSection = (typeof MY_TASK_SECTIONS)[number];

export const MY_TASK_SECTION_LABEL: Record<MyTaskSection, string> = {
  overdue: "Overdue",
  today: "Today",
  week: "This week",
  later: "Later",
  waiting: "Waiting on others",
  approve: "Awaiting my approval",
};

export interface BucketTask {
  status: TaskStatus;
  dueOn: string | null;
  assigneeId: string | null;
  approverId: string | null;
}

/** End of the ET work week (Sunday) containing `today`. */
export function endOfWeek(today: string): string {
  const dow = dayOfWeek(today); // 0 = Sunday
  return addDays(today, dow === 0 ? 0 : 7 - dow);
}

/**
 * Which My Tasks section a task belongs in for `userId` (null = not theirs).
 * Tasks they must approve go to "Awaiting my approval"; their own tasks that
 * are waiting on a third party or awaiting someone else's approval go to
 * "Waiting on others"; everything else by due date.
 */
export function myTaskSection(t: BucketTask, userId: string, today: string): MyTaskSection | null {
  if (t.status === "awaiting_approval" && t.approverId === userId) return "approve";
  if (t.assigneeId !== userId || t.status === "done") return null;
  if (t.status === "waiting" || t.status === "awaiting_approval") return "waiting";
  if (!t.dueOn) return "later";
  if (t.dueOn < today) return "overdue";
  if (t.dueOn === today) return "today";
  if (t.dueOn <= endOfWeek(today)) return "week";
  return "later";
}

export function daysOverdue(dueOn: string, today: string): number {
  return Math.max(0, daysBetween(dueOn, today));
}

/* ------------------------------------------------------------------ */
/* Next action (portfolio cards)                                       */
/* ------------------------------------------------------------------ */

export interface ActionCandidate {
  id: string;
  title: string;
  status: TaskStatus;
  dueOn: string | null;
  sortOrder: number;
  phaseOrder: number;
  blockedByDeps: boolean;
}

/**
 * The project's next action: the open task in the earliest phase that isn't
 * waiting on a prerequisite, earliest due first, then checklist order.
 */
export function nextAction<T extends ActionCandidate>(tasks: readonly T[]): T | null {
  const open = tasks.filter((t) => t.status !== "done" && !t.blockedByDeps);
  if (open.length === 0) return null;
  return [...open].sort((a, b) => a.phaseOrder - b.phaseOrder || (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") || a.sortOrder - b.sortOrder)[0]!;
}
