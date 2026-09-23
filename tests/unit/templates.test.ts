import { describe, expect, it } from "vitest";
import { addBusinessDays, holidays, isBusinessDay, nextBusinessDay, offsetDate } from "@/core/calendar";
import { cyclePath, dependents, edgesFrom, findCycle, topoOrder, unmetDependencies, wouldCreateCycle } from "@/core/deps";
import { DEFAULT_TEMPLATE_TYPES, defaultTemplate, LIBRARY_TASKS } from "@/core/seed-library";
import {
  diffIsEmpty,
  generateChecklist,
  projectToTemplate,
  scheduleDueDates,
  slugKey,
  templateUpdateDiff,
  toggleImpact,
  validateTemplate,
  type LiveTask,
  type SchedulableTask,
  type TemplateDef,
} from "@/core/templates";
import { conditionsMet, describeConditions, impliedToggles, irrelevantToggles, isToggleKey, toggleLabel, TOGGLES } from "@/core/toggles";

describe("business days and holidays", () => {
  it("knows the observed federal holidays", () => {
    const h2026 = holidays(2026);
    for (const d of ["2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25"]) {
      expect(h2026.has(d), d).toBe(true);
    }
    expect(h2026.size).toBe(11);
    // July 4, 2026 is a Saturday → observed Friday July 3.
    expect(h2026.has("2026-07-04")).toBe(false);
    // Jan 1, 2028 is a Saturday → observed Friday Dec 31, 2027 (counted in 2027).
    expect(holidays(2027).has("2027-12-31")).toBe(true);
    // Christmas 2027 is a Saturday → Friday the 24th; Juneteenth 2027 is a Saturday → Friday the 18th.
    expect(holidays(2027).has("2027-12-24")).toBe(true);
    expect(holidays(2027).has("2027-06-18")).toBe(true);
    // Sunday holidays move to Monday: July 4, 2027 → July 5.
    expect(holidays(2027).has("2027-07-05")).toBe(true);
  });

  it("skips weekends and holidays", () => {
    expect(isBusinessDay("2026-09-23")).toBe(true); // Wednesday
    expect(isBusinessDay("2026-09-26")).toBe(false); // Saturday
    expect(isBusinessDay("2026-11-26")).toBe(false); // Thanksgiving
    expect(nextBusinessDay("2026-09-26")).toBe("2026-09-28");
    expect(nextBusinessDay("2026-11-26")).toBe("2026-11-27");
    expect(addBusinessDays("2026-09-25", 1)).toBe("2026-09-28"); // Fri + 1 → Mon
    expect(addBusinessDays("2026-11-25", 1)).toBe("2026-11-27"); // over Thanksgiving
    expect(addBusinessDays("2026-12-23", 2)).toBe("2026-12-28"); // over Christmas and the weekend
    expect(addBusinessDays("2026-09-28", -1)).toBe("2026-09-25");
    expect(addBusinessDays("2026-09-26", 0)).toBe("2026-09-28");
    expect(() => addBusinessDays("nope", 1)).toThrow();
  });

  it("calendar offsets never land on a closed day", () => {
    expect(offsetDate("2026-09-21", 5, "calendar")).toBe("2026-09-28"); // lands Saturday → Monday
    expect(offsetDate("2026-09-21", 3, "calendar")).toBe("2026-09-24");
    expect(offsetDate("2026-09-21", 5, "business")).toBe("2026-09-28");
    // Across the spring-forward DST weekend the arithmetic stays calendar-based.
    expect(offsetDate("2026-03-06", 2, "calendar")).toBe("2026-03-09");
  });
});

describe("dependencies", () => {
  const e = edgesFrom([
    { taskId: "b", dependsOnId: "a" },
    { taskId: "c", dependsOnId: "b" },
    { taskId: "c", dependsOnId: "b" }, // duplicate ignored
    { taskId: "d", dependsOnId: "a" },
  ]);

  it("blocks cycles, including self-dependencies", () => {
    expect(wouldCreateCycle(e, "a", "c")).toBe(true);
    expect(wouldCreateCycle(e, "a", "a")).toBe(true);
    expect(wouldCreateCycle(e, "d", "c")).toBe(false);
    expect(cyclePath(e, "a", "c")).toEqual(["a", "c", "b", "a"]);
    expect(cyclePath(e, "a", "a")).toEqual(["a", "a"]);
    expect(cyclePath(e, "d", "c")).toBeNull();
  });

  it("explains what's blocking a task", () => {
    const done = new Set(["a"]);
    expect(unmetDependencies(e, "c", (x) => done.has(x))).toEqual(["b"]);
    expect(unmetDependencies(e, "b", (x) => done.has(x))).toEqual([]);
    expect(unmetDependencies(e, "z", () => false)).toEqual([]);
    expect(dependents(e, "a").sort()).toEqual(["b", "d"]);
  });

  it("orders dependencies first and rejects cycles", () => {
    expect(topoOrder(["c", "d", "b", "a"], e)).toEqual(["a", "b", "c", "d"]);
    expect(findCycle(["a", "b", "c", "d"], e)).toBeNull();
    const loop = edgesFrom([
      { taskId: "x", dependsOnId: "y" },
      { taskId: "y", dependsOnId: "z" },
      { taskId: "z", dependsOnId: "x" },
    ]);
    expect(findCycle(["x", "y", "z"], loop)).toEqual(["x", "y", "z", "x"]);
    expect(() => topoOrder(["x"], loop)).toThrow(/cycle/);
  });
});

describe("toggles", () => {
  it("has all fifteen toggles from the brief", () => {
    expect(TOGGLES).toHaveLength(15);
    expect(isToggleKey("excavation")).toBe(true);
    expect(isToggleKey("nope")).toBe(false);
    expect(toggleLabel("jv")).toBe("JV partner / outside equity");
    expect(toggleLabel("custom")).toBe("custom");
  });
  it("types imply and hide toggles", () => {
    expect(impliedToggles("foreclosure_auction")).toEqual(["foreclosure"]);
    expect(impliedToggles("contract_flip")).toEqual(["contract_flip"]);
    expect(impliedToggles("gut_renovation")).toEqual([]);
    expect(irrelevantToggles("contract_flip")).toContain("excavation");
    expect(irrelevantToggles("foreclosure_auction")).not.toContain("excavation");
    expect(irrelevantToggles("ground_up_condo")).toContain("foreclosure");
  });
  it("evaluates show/hide conditions", () => {
    const on = new Set(["excavation"]);
    expect(conditionsMet({}, on)).toBe(true);
    expect(conditionsMet({ showIf: ["excavation", "demolition"] }, on)).toBe(true);
    expect(conditionsMet({ showIf: ["demolition"] }, on)).toBe(false);
    expect(conditionsMet({ hideIf: ["excavation"] }, on)).toBe(false);
    expect(conditionsMet({ showIf: [] }, on)).toBe(true);
    expect(describeConditions({ showIf: ["excavation"], hideIf: ["rental_hold"] })).toBe("only if Excavation / underpinning; not if Rental hold (not a condo sale)");
    expect(describeConditions({})).toBeNull();
  });
});

describe("the seed library (brief §5.4)", () => {
  it("every default template is valid: no missing references, no cycles", () => {
    for (const type of DEFAULT_TEMPLATE_TYPES) {
      const t = defaultTemplate(type);
      expect(validateTemplate(t), type).toEqual([]);
      expect(t.tasks.length, type).toBeGreaterThan(20);
    }
  });

  it("keys are unique across the library and every task has a role and a due rule", () => {
    const keys = LIBRARY_TASKS.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of LIBRARY_TASKS) {
      expect(k.role, k.key).toBeTruthy();
      expect(k.due.days, k.key).toBeGreaterThanOrEqual(0);
      if (k.requiresApproval) expect(k.approverRole, k.key).toBeTruthy();
    }
  });

  it("wires the dependencies the brief calls out", () => {
    const t = defaultTemplate("ground_up_condo");
    const get = (k: string) => t.tasks.find((x) => x.key === k)!;
    expect(get("dob_filed").dependsOn).toContain("construction_documents");
    expect(get("gc_contract").dependsOn).toContain("gc_selected");
    expect(get("funds_wired").dependsOn).toEqual(expect.arrayContaining(["title_report", "go_no_go"]));
    expect(get("mih_check").killScreen).toBe(true);
    expect(get("partner_approval_offer").requiresApproval).toBe(true);
  });

  it("toggles add the tagged tasks", () => {
    const t = defaultTemplate("gut_renovation");
    const base = generateChecklist(t, new Set());
    const withExcavation = generateChecklist(t, new Set(["excavation"]));
    const added = withExcavation.tasks.filter((k) => !base.tasks.some((b) => b.key === k.key)).map((k) => k.key);
    expect(added.sort()).toEqual(["adjacent_survey", "geotech", "rpapl_881", "soe_design"]);
    expect(withExcavation.tasks.find((k) => k.key === "geotech")?.toggleSource).toEqual(["excavation"]);
  });

  it("rental hold swaps the AG plan phase for Rental / Hold", () => {
    const t = defaultTemplate("ground_up_condo");
    const condo = generateChecklist(t, new Set()).phases.map((p) => p.key);
    const rental = generateChecklist(t, new Set(["rental_hold"])).phases.map((p) => p.key);
    expect(condo).toContain("ag_plan_sales");
    expect(condo).not.toContain("rental_hold");
    expect(rental).toContain("rental_hold");
    expect(rental).not.toContain("ag_plan_sales");
  });

  it("each type gets its own phase track", () => {
    expect(generateChecklist(defaultTemplate("contract_flip"), new Set(["contract_flip"])).phases.map((p) => p.name)).toEqual([
      "Pipeline",
      "Under Contract",
      "Marketing to End Buyers",
      "Assignment",
      "Sold Out / Closed",
    ]);
    const auction = generateChecklist(defaultTemplate("foreclosure_auction"), new Set(["foreclosure"]));
    expect(auction.phases.slice(0, 3).map((p) => p.key)).toEqual(["pipeline", "auction", "closing"]);
    // Offer / LOI doesn't apply to an auction; the flip-only task doesn't appear in a condo build.
    expect(auction.tasks.some((k) => k.key === "offer_sent")).toBe(false);
    expect(generateChecklist(defaultTemplate("ground_up_condo"), new Set()).tasks.some((k) => k.key === "assignment_rights")).toBe(false);
    // Recurring construction tasks carry their rule.
    const gu = generateChecklist(defaultTemplate("ground_up_condo"), new Set(["construction_loan"]));
    expect(gu.tasks.find((k) => k.key === "monthly_draw")?.recurrence).toEqual({ freq: "monthly" });
    expect(gu.tasks.find((k) => k.key === "oac_meeting")?.recurrence).toEqual({ freq: "weekly" });
  });
});

const mini: TemplateDef = {
  name: "Mini",
  projectType: "gut_renovation",
  phases: [
    { key: "p1", name: "One" },
    { key: "p2", name: "Two" },
    { key: "p3", name: "Only rental", showIf: ["rental_hold"] },
  ],
  tasks: [
    { key: "a", phaseKey: "p1", title: "A", role: "PM", due: { days: 5, unit: "business", from: "phase_start" } },
    { key: "b", phaseKey: "p1", title: "B", role: "PM", due: { days: 3, unit: "calendar", from: { task: "a" } }, dependsOn: ["a"] },
    { key: "x", phaseKey: "p1", title: "Excavation thing", role: "PM", due: { days: 1, unit: "business", from: "phase_start" }, showIf: ["excavation"] },
    { key: "c", phaseKey: "p2", title: "C", role: "PM", due: { days: 2, unit: "business", from: "phase_start" }, dependsOn: ["x", "b"] },
    { key: "r", phaseKey: "p3", title: "Rent", role: "PM", due: { days: 2, unit: "business", from: "phase_start" } },
  ],
};

describe("template engine", () => {
  it("drops dependencies on tasks that aren't in the project", () => {
    const g = generateChecklist(mini, new Set());
    expect(g.tasks.map((k) => k.key)).toEqual(["a", "b", "c"]);
    expect(g.tasks.find((k) => k.key === "c")?.dependsOn).toEqual(["b"]);
    const gx = generateChecklist(mini, new Set(["excavation"]));
    expect(gx.tasks.find((k) => k.key === "c")?.dependsOn).toEqual(["x", "b"]);
  });

  it("validation catches every kind of broken template", () => {
    const bad: TemplateDef = {
      name: " ",
      projectType: "gut_renovation",
      phases: [
        { key: "p", name: "" },
        { key: "p", name: "Dup" },
      ],
      tasks: [
        { key: "t1", phaseKey: "nope", title: "", role: "PM", due: { days: -1, unit: "business", from: { task: "t1" } }, dependsOn: ["t2"], requiresApproval: true },
        { key: "t2", phaseKey: "p", title: "Two", role: "PM", due: { days: 1, unit: "business", from: { task: "zz" } }, dependsOn: ["t1", "ghost"] },
        { key: "t2", phaseKey: "p", title: "Dup", role: "PM", due: { days: 1, unit: "business", from: "phase_start" } },
      ],
    };
    const msgs = validateTemplate(bad).map((p) => p.message).join(" | ");
    for (const m of [/needs a name/, /Every phase needs a name/, /share the key "p"/, /share the key "t2"/, /needs a title/, /phase that doesn't exist/, /0–3650/, /relative to itself/, /task that doesn't exist\./, /ghost/, /no approver role/, /go in a circle/]) {
      expect(msgs).toMatch(m);
    }
    expect(validateTemplate({ ...mini, phases: [], tasks: [] }).map((p) => p.message)).toContain("Add at least one phase.");
    const anchorLoop: TemplateDef = {
      ...mini,
      tasks: [
        { key: "a", phaseKey: "p1", title: "A", role: "PM", due: { days: 1, unit: "business", from: { task: "b" } } },
        { key: "b", phaseKey: "p1", title: "B", role: "PM", due: { days: 1, unit: "business", from: { task: "a" } } },
      ],
    };
    expect(validateTemplate(anchorLoop).map((p) => p.message)).toContain("Relative due dates go in a circle.");
  });

  it("schedules phase- and task-relative due dates, keeps manual ones, waits for unknown anchors", () => {
    const tasks: SchedulableTask[] = [
      { key: "a", phaseKey: "p1", due: { days: 5, unit: "business", from: "phase_start" }, dueOn: null, dueManual: false, completedOn: null },
      { key: "b", phaseKey: "p1", due: { days: 3, unit: "calendar", from: { task: "a" } }, dueOn: null, dueManual: false, completedOn: null },
      { key: "m", phaseKey: "p1", due: { days: 1, unit: "business", from: "phase_start" }, dueOn: "2026-12-01", dueManual: true, completedOn: null },
      { key: "c", phaseKey: "p2", due: { days: 2, unit: "business", from: "phase_start" }, dueOn: null, dueManual: false, completedOn: null },
      { key: "n", phaseKey: "p1", due: null, dueOn: null, dueManual: false, completedOn: null },
    ];
    const out = scheduleDueDates(tasks, new Map([["p1", "2026-09-21"]]));
    expect(out.get("a")).toBe("2026-09-28");
    expect(out.get("b")).toBe("2026-10-01");
    expect(out.has("m")).toBe(false);
    expect(out.has("c")).toBe(false); // phase 2 hasn't started
    // A completed anchor wins over its due date.
    const done = scheduleDueDates(
      tasks.map((t) => (t.key === "a" ? { ...t, dueOn: "2026-09-28", completedOn: "2026-09-22" } : t)),
      new Map([["p1", "2026-09-21"]]),
    );
    expect(done.get("b")).toBe("2026-09-25");
    // An anchor loop leaves dates alone instead of looping forever.
    const loop = scheduleDueDates(
      [
        { key: "a", phaseKey: "p1", due: { days: 1, unit: "business", from: { task: "b" } }, dueOn: null, dueManual: false, completedOn: null },
        { key: "b", phaseKey: "p1", due: { days: 1, unit: "business", from: { task: "a" } }, dueOn: null, dueManual: false, completedOn: null },
      ],
      new Map(),
    );
    expect(loop.size).toBe(0);
  });

  it("toggle impact: adds, removes not-started, asks about started, and handles phases", () => {
    const live: LiveTask[] = [
      { id: "1", templateKey: "a", title: "A", phaseKey: "p1", started: true },
      { id: "2", templateKey: "b", title: "B", phaseKey: "p1", started: false },
      { id: "3", templateKey: "c", title: "C", phaseKey: "p2", started: false },
      { id: "4", templateKey: null, title: "Hand-made", phaseKey: "p1", started: false },
    ];
    const phases = [
      { key: "p1", status: "active" as const },
      { key: "p2", status: "pending" as const },
    ];
    const on = toggleImpact(mini, new Set(), new Set(["excavation", "rental_hold"]), live, phases);
    expect(on.add.map((k) => k.key)).toEqual(["x", "r"]);
    expect(on.phasesAdded.map((p) => p.key)).toEqual(["p3"]);
    expect(on.remove).toEqual([]);

    const liveWithX = [...live, { id: "5", templateKey: "x", title: "Excavation thing", phaseKey: "p1", started: false }, { id: "6", templateKey: "r", title: "Rent", phaseKey: "p3", started: true }];
    const off = toggleImpact(mini, new Set(["excavation", "rental_hold"]), new Set(), liveWithX, [...phases, { key: "p3", status: "pending" }]);
    expect(off.remove.map((l) => l.id)).toEqual(["5"]);
    expect(off.ask.map((l) => l.id)).toEqual(["6"]);
    expect(off.phasesRemoved).toEqual(["p3"]);
    expect(off.add).toEqual([]);
  });

  it("template update diff touches only not-started template tasks", () => {
    const next: TemplateDef = {
      ...mini,
      tasks: [
        { ...mini.tasks[0]!, title: "A renamed" },
        { ...mini.tasks[1]!, title: "B renamed" },
        { key: "new", phaseKey: "p2", title: "Brand new", role: "PM", due: { days: 1, unit: "business", from: "phase_start" } },
      ],
    };
    const live: LiveTask[] = [
      { id: "1", templateKey: "a", title: "A", phaseKey: "p1", started: true },
      { id: "2", templateKey: "b", title: "B", phaseKey: "p1", started: false },
      { id: "3", templateKey: "c", title: "C", phaseKey: "p2", started: false },
      { id: "3b", templateKey: "c", title: "C", phaseKey: "p2", started: true },
      { id: "4", templateKey: null, title: "Mine", phaseKey: "p1", started: false },
    ];
    const d = templateUpdateDiff(next, new Set(), live);
    expect(d.add.map((k) => k.key)).toEqual(["new"]);
    expect(d.rename).toEqual([{ task: live[1], to: "B renamed" }]);
    expect(d.remove.map((l) => l.id)).toEqual(["3"]);
    expect(d.kept.map((l) => l.id).sort()).toEqual(["1", "3b"]);
    expect(diffIsEmpty(d)).toBe(false);
    expect(diffIsEmpty(templateUpdateDiff(mini, new Set(), [
      { id: "1", templateKey: "a", title: "A", phaseKey: "p1", started: false },
      { id: "2", templateKey: "b", title: "B", phaseKey: "p1", started: false },
      { id: "3", templateKey: "c", title: "C", phaseKey: "p2", started: false },
    ]))).toBe(true);
  });

  it("saves a live project as a template, keeping rules and mapping ids to keys", () => {
    const t = projectToTemplate({
      name: "From project",
      projectType: "gut_renovation",
      phases: [
        { key: "p1", name: "One", status: "done", startedOn: "2026-01-05" },
        { key: "p2", name: "Two", status: "active", startedOn: "2026-02-02" },
        { key: "p3", name: "Skipped", status: "skipped", startedOn: null },
      ],
      tasks: [
        { id: "i1", templateKey: "a", phaseKey: "p1", title: "A", description: null, role: "PM", dueOn: "2026-01-12", due: { days: 5, unit: "business", from: "phase_start" }, requiresApproval: false, approverRole: null, dependsOnIds: [], subItems: [], requiredAttachment: null, recurrence: null, toggleSource: [] },
        { id: "i2", templateKey: "b", phaseKey: "p1", title: "B", description: null, role: "PM", dueOn: null, due: { days: 3, unit: "calendar", from: { task: "a" } }, requiresApproval: true, approverRole: "Owner", dependsOnIds: ["i1"], subItems: ["x"], requiredAttachment: "PDF", recurrence: null, toggleSource: ["excavation"] },
        { id: "i3", templateKey: null, phaseKey: "p2", title: "Hand made!", description: "d", role: "Legal", dueOn: "2026-02-12", due: null, requiresApproval: false, approverRole: null, dependsOnIds: ["i2", "gone"], subItems: [], requiredAttachment: null, recurrence: { freq: "weekly" }, toggleSource: [] },
        { id: "i4", templateKey: null, phaseKey: "p2", title: "No date", description: null, role: "PM", dueOn: null, due: null, requiresApproval: false, approverRole: null, dependsOnIds: [], subItems: [], requiredAttachment: null, recurrence: null, toggleSource: [] },
        { id: "i5", templateKey: "orphan", phaseKey: "p3", title: "In skipped phase", description: null, role: "PM", dueOn: null, due: { days: 1, unit: "business", from: { task: "missing" } }, requiresApproval: false, approverRole: null, dependsOnIds: [], subItems: [], requiredAttachment: null, recurrence: null, toggleSource: [] },
        { id: "i6", templateKey: "a", phaseKey: "p2", title: "Duplicate key", description: null, role: "PM", dueOn: null, due: { days: 1, unit: "business", from: { task: "missing" } }, requiresApproval: false, approverRole: null, dependsOnIds: [], subItems: [], requiredAttachment: null, recurrence: null, toggleSource: [] },
      ],
    });
    expect(t.phases.map((p) => p.key)).toEqual(["p1", "p2"]);
    expect(t.tasks.map((k) => k.key)).toEqual(["a", "b", "hand_made", "no_date", "duplicate_key"]);
    expect(t.tasks[1]).toMatchObject({ dependsOn: ["a"], due: { from: { task: "a" } }, showIf: ["excavation"], requiresApproval: true });
    expect(t.tasks[2]).toMatchObject({ due: { days: 10, unit: "calendar", from: "phase_start" }, dependsOn: ["b"], recurrence: { freq: "weekly" } });
    expect(t.tasks[3]!.due.days).toBe(14);
    expect(t.tasks[4]!.due.from).toBe("phase_start");
    expect(validateTemplate(t)).toEqual([]);
  });

  it("slug keys are unique", () => {
    const taken = new Set<string>();
    expect(slugKey("Site visit!", taken)).toBe("site_visit");
    expect(slugKey("Site visit", taken)).toBe("site_visit_2");
    expect(slugKey("***", taken)).toBe("task");
  });
});
