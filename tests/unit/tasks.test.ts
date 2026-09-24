import { describe, expect, it } from "vitest";
import { KEY_DATE_KINDS, keyDateLabel, nextKeyDate, reminderDue, upcomingKeyDates } from "@/core/key-dates";
import { commentPlainText, mentionedIds, mentionMatches, mentionToken, parseComment } from "@/core/mentions";
import {
  canSetStatus,
  completionOutcome,
  daysOverdue,
  endOfWeek,
  myTaskSection,
  nextAction,
  nextOccurrence,
  shiftDate,
  TASK_STATUS_LABEL,
  type CompletionFacts,
} from "@/core/tasks";

describe("one-tap complete routing", () => {
  const base: CompletionFacts = { status: "not_started", unmetDependencies: 0, requiresApproval: false, requiredAttachment: null, attachmentCount: 0, canApprove: false };
  it("completes a plain task", () => expect(completionOutcome(base)).toEqual({ kind: "done" }));
  it("blocks on prerequisites first", () =>
    expect(completionOutcome({ ...base, unmetDependencies: 2, requiresApproval: true, requiredAttachment: "Survey" })).toEqual({ kind: "blocked", reason: "dependencies" }));
  it("routes to the attach step when a required file is missing", () => {
    expect(completionOutcome({ ...base, requiredAttachment: "Survey PDF" })).toEqual({ kind: "needs_attachment", label: "Survey PDF" });
    expect(completionOutcome({ ...base, requiredAttachment: "Survey PDF", attachmentCount: 1 })).toEqual({ kind: "done" });
  });
  it("sends for approval unless the person can approve", () => {
    expect(completionOutcome({ ...base, requiresApproval: true })).toEqual({ kind: "needs_approval" });
    expect(completionOutcome({ ...base, requiresApproval: true, canApprove: true })).toEqual({ kind: "done" });
  });
  it("is a no-op when already done", () => expect(completionOutcome({ ...base, status: "done" })).toEqual({ kind: "already_done" }));
  it("direct status changes exclude done and approval", () => {
    expect(canSetStatus("not_started", "waiting")).toBe(true);
    expect(canSetStatus("blocked", "in_progress")).toBe(true);
    expect(canSetStatus("in_progress", "done")).toBe(false);
    expect(canSetStatus("in_progress", "awaiting_approval")).toBe(false);
    expect(canSetStatus("awaiting_approval", "in_progress")).toBe(true);
    expect(canSetStatus("awaiting_approval", "blocked")).toBe(false);
    expect(canSetStatus("waiting", "waiting")).toBe(false);
    expect(TASK_STATUS_LABEL.waiting).toBe("Waiting on third party");
  });
});

describe("recurrence", () => {
  it("weekly and every two weeks, on business days", () => {
    expect(nextOccurrence("2026-09-21", "weekly", "2026-09-21")).toBe("2026-09-28");
    expect(nextOccurrence("2026-09-21", "biweekly", "2026-09-22")).toBe("2026-10-05");
    // Thanksgiving week: Thu Nov 19 + 7 = Thu Nov 26 (holiday) → Fri Nov 27.
    expect(nextOccurrence("2026-11-19", "weekly", "2026-11-19")).toBe("2026-11-27");
  });
  it("monthly clamps to the month's last day", () => {
    expect(nextOccurrence("2026-01-31", "monthly", "2026-01-31")).toBe("2026-03-02"); // Feb 28 is a Saturday → Mon Mar 2
    expect(nextOccurrence("2026-12-15", "monthly", "2026-12-15")).toBe("2027-01-15");
  });
  it("a late completion skips occurrences already past", () => {
    expect(nextOccurrence("2026-09-01", "weekly", "2026-09-20")).toBe("2026-09-22");
  });
});

describe("bulk re-dating", () => {
  it("shifts by business or calendar days", () => {
    expect(shiftDate("2026-09-25", 3, "business")).toBe("2026-09-30");
    expect(shiftDate("2026-09-25", 1, "calendar")).toBe("2026-09-28"); // Saturday → Monday
    expect(shiftDate("2026-09-28", -1, "business")).toBe("2026-09-25");
  });
});

describe("My Tasks sections", () => {
  const today = "2026-09-23"; // Wednesday
  const t = (over: Partial<Parameters<typeof myTaskSection>[0]> = {}) => ({ status: "not_started" as const, dueOn: null as string | null, assigneeId: "me", approverId: null as string | null, ...over });
  it("week ends Sunday", () => {
    expect(endOfWeek(today)).toBe("2026-09-27");
    expect(endOfWeek("2026-09-27")).toBe("2026-09-27");
  });
  it("sorts my tasks by due date", () => {
    expect(myTaskSection(t({ dueOn: "2026-09-20" }), "me", today)).toBe("overdue");
    expect(myTaskSection(t({ dueOn: today }), "me", today)).toBe("today");
    expect(myTaskSection(t({ dueOn: "2026-09-27" }), "me", today)).toBe("week");
    expect(myTaskSection(t({ dueOn: "2026-09-28" }), "me", today)).toBe("later");
    expect(myTaskSection(t(), "me", today)).toBe("later");
  });
  it("waiting and approvals have their own sections; others' and done tasks are excluded", () => {
    expect(myTaskSection(t({ status: "waiting", dueOn: "2026-01-01" }), "me", today)).toBe("waiting");
    expect(myTaskSection(t({ status: "awaiting_approval", approverId: "boss" }), "me", today)).toBe("waiting");
    expect(myTaskSection(t({ status: "awaiting_approval", assigneeId: "someone", approverId: "me" }), "me", today)).toBe("approve");
    expect(myTaskSection(t({ assigneeId: "someone" }), "me", today)).toBeNull();
    expect(myTaskSection(t({ status: "done" }), "me", today)).toBeNull();
    expect(daysOverdue("2026-09-20", today)).toBe(3);
    expect(daysOverdue("2026-09-30", today)).toBe(0);
  });
  it("next action skips done and blocked tasks, earliest phase and date first", () => {
    const c = (id: string, over: object) => ({ id, title: id, status: "not_started" as const, dueOn: null, sortOrder: 0, phaseOrder: 1, blockedByDeps: false, ...over });
    expect(
      nextAction([
        c("done", { status: "done", phaseOrder: 0 }),
        c("blocked", { blockedByDeps: true, phaseOrder: 0 }),
        c("later", { dueOn: "2026-10-01" }),
        c("sooner", { dueOn: "2026-09-25" }),
        c("undated", { sortOrder: -1 }),
      ])?.id,
    ).toBe("sooner");
    expect(nextAction([c("a", { status: "done" })])).toBeNull();
  });
});

describe("mentions", () => {
  const people = [
    { id: "u1", name: "Elias Ariel" },
    { id: "u2", name: "Ariel Cohen" },
  ];
  const body = `Hi ${mentionToken(people[0]!)} and ${mentionToken(people[1]!)}, also ${mentionToken({ id: "x9", name: "Stranger" })} and ${mentionToken(people[0]!)}`;
  it("finds allowed mentions once each", () => {
    expect(mentionedIds(body, people)).toEqual(["u1", "u2"]);
    expect(mentionedIds("no mentions", people)).toEqual([]);
  });
  it("parses for display and plain text", () => {
    const parts = parseComment(body, people);
    expect(parts.filter((p) => p.kind === "mention").map((p) => (p as { name: string }).name)).toEqual(["Elias Ariel", "Ariel Cohen", "Stranger", "Elias Ariel"]);
    expect(parts[0]).toEqual({ kind: "text", text: "Hi " });
    expect(commentPlainText(body)).toBe("Hi @Elias Ariel and @Ariel Cohen, also @Stranger and @Elias Ariel");
    expect(parseComment("plain")).toEqual([{ kind: "text", text: "plain" }]);
    expect(mentionToken({ id: "u3", name: "Odd]\nName" })).toBe("@[OddName](u3)");
  });
  it("suggests people as you type", () => {
    expect(mentionMatches("ari", people).map((p) => p.id)).toEqual(["u1", "u2"]);
    expect(mentionMatches("co", people).map((p) => p.id)).toEqual(["u2"]);
    expect(mentionMatches("", people, 1)).toHaveLength(1);
  });
});

describe("key dates", () => {
  const today = "2026-09-23";
  const d = (date: string, done = false) => ({ date, done });
  it("labels", () => {
    expect(KEY_DATE_KINDS.length).toBeGreaterThanOrEqual(8);
    expect(keyDateLabel("toe")).toBe("Time of the essence (TOE)");
    expect(keyDateLabel("other", "Board meeting")).toBe("Board meeting");
    expect(keyDateLabel("mystery")).toBe("mystery");
  });
  it("finds the next and upcoming dates", () => {
    const list = [d("2026-09-01"), d("2026-09-30"), d("2026-09-24", true), d("2026-10-07"), d("2026-12-01")];
    expect(nextKeyDate(list, today)?.date).toBe("2026-09-30");
    expect(upcomingKeyDates(list, today).map((x) => x.date)).toEqual(["2026-09-30", "2026-10-07"]);
    expect(nextKeyDate([d("2026-01-01")], today)).toBeNull();
  });
  it("reminders at 14, 7 and 1 days", () => {
    expect(reminderDue("2026-10-07", today)).toBe(14);
    expect(reminderDue("2026-09-30", today)).toBe(7);
    expect(reminderDue("2026-09-24", today)).toBe(1);
    expect(reminderDue("2026-09-25", today)).toBeNull();
  });
});
