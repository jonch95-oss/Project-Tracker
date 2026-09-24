import { describe, expect, it } from "vitest";
import {
  businessDaysBetween,
  median,
  mean,
  perSf,
  phaseDurations,
  suggestDurations,
  type DurationSample,
} from "@/core/analytics";
import { buildCalendar, foldLine, icsText } from "@/core/ics";
import {
  buildTemplateParts,
  guessMapping,
  parseCsv,
  validateRows,
} from "@/core/import";
import {
  emailAddressOf,
  htmlToText,
  inboundKeyFor,
  inboundKeyFromRecipient,
  parseInboundPayload,
  signWebhook,
  verifyWebhookSignature,
} from "@/core/inbound";

describe("ics", () => {
  it("escapes text values", () => {
    expect(icsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });
  it("folds long lines at 75 octets without splitting characters", () => {
    const line = `SUMMARY:${"é".repeat(60)}`;
    const folded = foldLine(line);
    for (const part of folded.split("\r\n"))
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    expect(
      folded
        .split("\r\n")
        .map((p, i) => (i ? p.slice(1) : p))
        .join(""),
    ).toBe(line);
    expect(foldLine("short")).toBe("short");
  });
  it("builds all-day events with stable UIDs and CRLF endings", () => {
    const text = buildCalendar({
      name: "Project Command",
      domain: "example.com",
      stamp: new Date("2026-09-24T12:00:00Z"),
      events: [
        {
          uid: "task-1",
          date: "2026-12-31",
          title: "File, permit",
          location: "347 Myrtle",
        },
        { uid: "bad", date: "soon", title: "skipped" },
      ],
    });
    expect(text).toContain("UID:task-1@example.com\r\n");
    expect(text).toContain(
      "DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101",
    );
    expect(text).toContain("SUMMARY:File\\, permit");
    expect(text).toContain("DTSTAMP:20260924T120000Z");
    expect(text).not.toContain("skipped");
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(text.split("BEGIN:VEVENT").length).toBe(2);
  });
});

describe("analytics", () => {
  it("median, mean and per-sf", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(perSf(1_000_000, 400)).toBe(2500);
    expect(perSf(1_000_000, 0)).toBeNull();
    expect(perSf(null, 400)).toBeNull();
  });
  it("counts business days (weekends and holidays out)", () => {
    expect(businessDaysBetween("2026-09-25", "2026-09-25")).toBe(0);
    expect(businessDaysBetween("2026-09-25", "2026-09-28")).toBe(1); // Fri → Mon
    expect(businessDaysBetween("2026-12-24", "2026-12-28")).toBe(1); // Christmas out
  });
  it("medians phase durations by type", () => {
    const out = phaseDurations([
      {
        type: "gut_renovation",
        phaseKey: "permits",
        phaseName: "Permits",
        startedOn: "2026-01-01",
        completedOn: "2026-01-11",
      },
      {
        type: "gut_renovation",
        phaseKey: "permits",
        phaseName: "Permits",
        startedOn: "2026-02-01",
        completedOn: "2026-02-21",
      },
      {
        type: "gut_renovation",
        phaseKey: "permits",
        phaseName: "Permits",
        startedOn: "2026-03-10",
        completedOn: "2026-03-01",
      },
    ]);
    expect(out).toEqual([
      {
        type: "gut_renovation",
        phases: [{ key: "permits", name: "Permits", medianDays: 15, n: 2 }],
      },
    ]);
  });
  it("suggests durations only with enough samples and a real difference", () => {
    const s = (
      completedOn: string,
      key = "t1",
      currentDays = 5,
    ): DurationSample => ({
      templateKey: key,
      title: key,
      phaseKey: "p",
      unit: "calendar",
      currentDays,
      phaseStartedOn: "2026-01-01",
      completedOn,
    });
    expect(suggestDurations([s("2026-01-21"), s("2026-01-21")])).toEqual([]);
    const out = suggestDurations([
      s("2026-01-21"),
      s("2026-01-16"),
      s("2026-01-26"),
      s("2026-01-07", "t2", 5),
      s("2026-01-07", "t2", 5),
      s("2026-01-07", "t2", 5),
    ]);
    expect(out).toEqual([
      {
        templateKey: "t1",
        title: "t1",
        phaseKey: "p",
        unit: "calendar",
        currentDays: 5,
        suggestedDays: 20,
        samples: 3,
      },
    ]);
  });
});

describe("import", () => {
  it("parses CSV with quotes, commas, newlines, CRLF and a BOM", () => {
    expect(
      parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\n,\n3,4\n'),
    ).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
      ["3", "4"],
    ]);
  });
  it("guesses columns from headers", () => {
    expect(
      guessMapping("units", ["Unit #", "SQFT", "Bedrooms", "Asking Price"]),
    ).toMatchObject({ unit: 0, sf: 1, beds: 2, askCents: 3 });
    expect(guessMapping("units", ["Unit", "Floor"])).toMatchObject({
      unit: 0,
      floor: 1,
    });
  });
  it("validates rows and says why each rejected row was rejected", () => {
    const { valid, rejected } = validateRows(
      "units",
      [
        ["2A", "1,050", "2", "$1,250,000"],
        ["", "900", "1", ""],
        ["3B", "big", "1.3", ""],
        ["2a", "800", "1", ""],
      ],
      { unit: 0, sf: 1, beds: 2, askCents: 3 },
    );
    expect(valid).toEqual([
      {
        row: 2,
        values: { unit: "2A", sf: 1050, beds: 2, askCents: 125_000_000 },
      },
    ]);
    expect(rejected.map((r) => r.row)).toEqual([3, 4, 5]);
    expect(rejected[0]!.reasons).toEqual(["Unit is missing"]);
    expect(rejected[1]!.reasons.join(" ")).toMatch(
      /Square feet "big" isn't a whole number.*Bedrooms/,
    );
    expect(rejected[2]!.reasons).toEqual(["Same unit as row 2"]);
  });
  it("builds template phases and tasks, linking by title", () => {
    const { valid } = validateRows(
      "template",
      [
        ["Permits", "File plans", "", "10", "", "", "yes", ""],
        [
          "Permits",
          "Get approval",
          "Expediter",
          "20",
          "calendar",
          "file plans",
          "",
          "y",
        ],
        ["Build", "Start work", "", "", "", "Nothing like it", "", ""],
      ],
      {
        phase: 0,
        title: 1,
        role: 2,
        days: 3,
        unit: 4,
        after: 5,
        milestone: 6,
        approval: 7,
      },
    );
    const parts = buildTemplateParts(valid);
    expect(parts.phases).toEqual([
      { key: "permits", name: "Permits" },
      { key: "build", name: "Build" },
    ]);
    expect(parts.tasks[0]).toMatchObject({
      key: "file_plans",
      role: "PM",
      due: { days: 10, unit: "business", from: "phase_start" },
      milestone: true,
    });
    expect(parts.tasks[1]).toMatchObject({
      key: "get_approval",
      role: "Expediter",
      due: { days: 20, unit: "calendar", from: { task: "file_plans" } },
      requiresApproval: true,
    });
    expect(parts.unresolved).toEqual([
      {
        row: 4,
        reasons: ['After task "Nothing like it" isn\'t a task in this file'],
      },
    ]);
  });
});

describe("inbound email", () => {
  it("makes addresses from the street address plus a random suffix", () => {
    expect(
      inboundKeyFor(
        "347 Myrtle Ave, Brooklyn, NY",
        "Myrtle",
        new Uint8Array([0, 1, 2, 3]),
      ),
    ).toBe("347-myrtle-abcd");
    expect(
      inboundKeyFor(
        ", ,",
        "The Pacific Project",
        new Uint8Array([30, 30, 30, 30]),
      ),
    ).toMatch(/^pacific-project-[a-z2-9]{4}$/);
  });
  it("reads sender and recipient addresses", () => {
    expect(emailAddressOf('"Dana Levi" <Dana@Example.com>')).toBe(
      "dana@example.com",
    );
    expect(emailAddressOf("not an address")).toBeNull();
    expect(
      inboundKeyFromRecipient(
        "Project <347-myrtle-abcd@in.example.com>",
        "in.example.com",
      ),
    ).toBe("347-myrtle-abcd");
    expect(
      inboundKeyFromRecipient(
        "347-myrtle-abcd+ref@IN.example.com",
        "in.example.com",
      ),
    ).toBe("347-myrtle-abcd");
    expect(
      inboundKeyFromRecipient(
        "347-myrtle-abcd@elsewhere.com",
        "in.example.com",
      ),
    ).toBeNull();
  });
  it("verifies signatures and refuses stale or altered ones", () => {
    const secret = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;
    const now = Date.UTC(2026, 8, 24, 12);
    const ts = Math.floor(now / 1000);
    const sig = signWebhook(secret, "msg_1", ts, "{}");
    expect(
      verifyWebhookSignature(
        secret,
        { id: "msg_1", timestamp: String(ts), signature: `v1,bogus ${sig}` },
        "{}",
        now,
      ),
    ).toBe(true);
    expect(
      verifyWebhookSignature(
        secret,
        { id: "msg_1", timestamp: String(ts), signature: sig },
        "{ }",
        now,
      ),
    ).toBe(false);
    expect(
      verifyWebhookSignature(
        secret,
        { id: "msg_2", timestamp: String(ts), signature: sig },
        "{}",
        now,
      ),
    ).toBe(false);
    expect(
      verifyWebhookSignature(
        secret,
        { id: "msg_1", timestamp: String(ts), signature: sig },
        "{}",
        now + 6 * 60_000,
      ),
    ).toBe(false);
    expect(
      verifyWebhookSignature(
        secret,
        { id: "msg_1", timestamp: null, signature: sig },
        "{}",
        now,
      ),
    ).toBe(false);
  });
  it("parses the provider's email.received event", () => {
    const msg = parseInboundPayload(
      {
        type: "email.received",
        data: {
          email_id: "e1",
          from: "Dana <dana@x.com>",
          to: ["a@in.x.com"],
          subject: "Survey",
          html: "<p>Hi&nbsp;there</p><p>See attached</p>",
          attachments: [
            {
              filename: "survey.pdf",
              content_type: "application/pdf",
              content: Buffer.from("%PDF").toString("base64"),
            },
            { filename: "big.zip" },
          ],
        },
      },
      "d1",
    );
    expect(msg).toMatchObject({
      providerId: "e1",
      from: "Dana <dana@x.com>",
      to: ["a@in.x.com"],
      subject: "Survey",
      text: "Hi there\nSee attached",
    });
    expect(
      msg!.attachments.map((a) => [a.filename, a.content?.length ?? null]),
    ).toEqual([
      ["survey.pdf", 4],
      ["big.zip", null],
    ]);
    expect(
      parseInboundPayload({ type: "email.sent", data: {} }, "d"),
    ).toBeNull();
    expect(htmlToText("<style>x</style>a<br>b")).toBe("a\nb");
  });
});
