import { describe, expect, it } from "vitest";
import { baselineItems, criticalPath, forecast, plannedSpan, slippageDays, slippageLabel, type ScheduleTask } from "@/core/schedule";

const T = (id: string, startOn: string | null, dueOn: string | null, deps: string[] = [], extra: Partial<ScheduleTask> = {}): ScheduleTask => ({ id, startOn, dueOn, startedOn: null, completedOn: null, done: false, deps, ...extra });

describe("schedule", () => {
  it("spans: a start after the finish, or none, is a one-day task", () => {
    expect(plannedSpan({ startOn: "2026-10-01", dueOn: "2026-10-05" })).toEqual({ start: "2026-10-01", finish: "2026-10-05" });
    expect(plannedSpan({ startOn: null, dueOn: "2026-10-05" })).toEqual({ start: "2026-10-05", finish: "2026-10-05" });
    expect(plannedSpan({ startOn: "2026-10-09", dueOn: "2026-10-05" })).toEqual({ start: "2026-10-05", finish: "2026-10-05" });
    expect(plannedSpan({ startOn: "2026-10-01", dueOn: null })).toBeNull();
  });

  it("critical path: the longest dependent chain has no slack", () => {
    const tasks = [
      T("excavate", "2026-10-01", "2026-10-10"),
      T("foundation", "2026-10-11", "2026-10-25", ["excavate"]),
      T("permits", "2026-10-01", "2026-10-03"),
      T("frame", "2026-10-26", "2026-11-20", ["foundation", "permits"]),
      T("undated", null, null, ["frame"]),
    ];
    const cp = criticalPath(tasks);
    expect([...cp.critical].sort()).toEqual(["excavate", "foundation", "frame"]);
    expect(cp.slack.get("permits")).toBe(22);
    expect(cp.finish).toBe("2026-11-20");
    // A dependency pushes a successor planned too early.
    const pushed = criticalPath([T("a", "2026-10-01", "2026-10-10"), T("b", "2026-10-05", "2026-10-06", ["a"])]);
    expect(pushed.finish).toBe("2026-10-12");
    expect(criticalPath([]).finish).toBeNull();
    // Cycles don't hang.
    expect(criticalPath([T("x", "2026-10-01", "2026-10-02", ["y"]), T("y", "2026-10-03", "2026-10-04", ["x"])]).finish).toBe("2026-10-06");
  });

  it("forecast: late starts and overdue work push the finish; done work stays put", () => {
    const tasks = [
      T("excavate", "2026-10-01", "2026-10-10", [], { done: true, startedOn: "2026-10-01", completedOn: "2026-10-14" }),
      T("foundation", "2026-10-11", "2026-10-25", ["excavate"]),
      T("frame", "2026-10-26", "2026-11-20", ["foundation"]),
    ];
    const f = forecast(tasks, "2026-10-12");
    expect(f.byTask.get("foundation")).toEqual({ start: "2026-10-15", finish: "2026-10-29" });
    expect(f.finish).toBe("2026-11-24");
    expect(slippageDays("2026-11-20", f.finish)).toBe(4);
    // Started work keeps its actual start; overdue work finishes today at the earliest.
    const g = forecast([T("x", "2026-10-01", "2026-10-05", [], { startedOn: "2026-10-02" })], "2026-10-09");
    expect(g.byTask.get("x")).toEqual({ start: "2026-10-02", finish: "2026-10-09" });
    expect(forecast([], "2026-10-01").finish).toBeNull();
    expect(forecast([T("u", null, null), T("v", null, null, ["u"])], "2026-10-01").finish).toBeNull();
  });

  it("baseline and labels", () => {
    const b = baselineItems([T("a", "2026-10-01", "2026-10-10"), T("b", null, null)]);
    expect(b).toEqual({ items: [{ taskId: "a", start: "2026-10-01", finish: "2026-10-10" }], finish: "2026-10-10" });
    expect(slippageLabel(0)).toBe("On baseline");
    expect(slippageLabel(1)).toBe("1 day behind");
    expect(slippageLabel(-3)).toBe("3 days ahead");
    expect(slippageLabel(null)).toBeNull();
    expect(slippageDays(null, "2026-10-01")).toBeNull();
  });
});
