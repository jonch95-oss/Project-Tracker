import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  computeAuditHash,
  GENESIS_HASH,
  scrubAuditData,
  sha256Hex,
  verifyAuditChain,
  type AuditEntryContent,
  type StoredAuditEntry,
} from "@/core/audit";
import {
  alertsToSend,
  billableMinutes,
  evaluateUsage,
  FREE_TIER_LIMITS,
  formatBytes,
  formatUsage,
  periodKey,
  usageLevel,
} from "@/core/freeTier";
import {
  addDays,
  dayOfWeek,
  daysBetween,
  formatDateTimeET,
  formatIsoDate,
  hourET,
  isIsoDate,
  minuteOfDayET,
  parseIso,
  startOfDayET,
  todayET,
} from "@/core/time";

describe("time (America/New_York)", () => {
  it("today is the New York date, not UTC", () => {
    // 2026-03-05 03:30 UTC is still March 4 in New York (EST, UTC−5).
    expect(todayET(new Date("2026-03-05T03:30:00Z"))).toBe("2026-03-04");
    expect(todayET(new Date("2026-03-05T05:00:00Z"))).toBe("2026-03-05");
    // Summer (EDT, UTC−4)
    expect(todayET(new Date("2026-07-01T03:59:00Z"))).toBe("2026-06-30");
    expect(todayET(new Date("2026-07-01T04:00:00Z"))).toBe("2026-07-01");
  });

  it("handles DST transition days", () => {
    // Spring forward 2026-03-08: the day is 23 hours long.
    const start = startOfDayET("2026-03-08");
    const next = startOfDayET("2026-03-09");
    expect((next.getTime() - start.getTime()) / 3_600_000).toBe(23);
    expect(start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    // Fall back 2026-11-01: 25 hours long.
    const f = startOfDayET("2026-11-01");
    const g = startOfDayET("2026-11-02");
    expect((g.getTime() - f.getTime()) / 3_600_000).toBe(25);
    // 01:30 happens twice on fall-back day; both are Nov 1 in New York.
    expect(todayET(new Date("2026-11-01T05:30:00Z"))).toBe("2026-11-01");
    expect(todayET(new Date("2026-11-01T06:30:00Z"))).toBe("2026-11-01");
  });

  it("hour and minute of day in New York", () => {
    expect(hourET(new Date("2026-01-15T12:00:00Z"))).toBe(7);
    expect(hourET(new Date("2026-07-15T11:00:00Z"))).toBe(7);
    expect(minuteOfDayET(new Date("2026-01-15T12:30:00Z"))).toBe(7 * 60 + 30);
  });

  it("date arithmetic is calendar-based", () => {
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(daysBetween("2026-03-01", "2026-03-15")).toBe(14);
    expect(daysBetween("2026-03-15", "2026-03-01")).toBe(-14);
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2); // across DST
    expect(dayOfWeek("2026-09-23")).toBe(3); // Wednesday
  });

  it("validates ISO dates", () => {
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("26-01-01")).toBe(false);
    expect(() => parseIso("nope")).toThrow();
  });

  it("formats for display", () => {
    expect(formatIsoDate("2026-03-04")).toBe("Mar 4, 2026");
    expect(formatDateTimeET(new Date("2026-03-05T03:30:00Z"))).toMatch(/Mar 4, 2026.*10:30/);
  });
});

describe("audit chain", () => {
  it("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(new Date("2026-01-01T00:00:00Z"))).toBe('"2026-01-01T00:00:00.000Z"');
    expect(canonicalJson("x")).toBe('"x"');
  });

  it("sha256 matches a known vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  async function buildChain(n: number): Promise<StoredAuditEntry[]> {
    const out: StoredAuditEntry[] = [];
    let prev = GENESIS_HASH;
    for (let i = 1; i <= n; i++) {
      const content: AuditEntryContent = {
        seq: i,
        occurredAt: new Date(Date.UTC(2026, 0, i)).toISOString(),
        actorId: "u1",
        action: "update",
        entityType: "task",
        entityId: `t${i}`,
        projectId: null,
        summary: `Change ${i}`,
        data: { field: "status", to: "done" },
        ip: null,
      };
      const hash = await computeAuditHash(prev, content);
      out.push({ ...content, prevHash: prev, hash });
      prev = hash;
    }
    return out;
  }

  it("verifies an intact chain", async () => {
    const chain = await buildChain(5);
    const result = await verifyAuditChain(chain);
    expect(result).toEqual({ ok: true, checked: 5, lastHash: chain[4]!.hash });
  });

  it("detects edited content", async () => {
    const chain = await buildChain(5);
    chain[2] = { ...chain[2]!, summary: "Innocent change" };
    const result = await verifyAuditChain(chain);
    expect(result).toMatchObject({ ok: false, brokenAtSeq: 3, reason: "Entry content was altered" });
  });

  it("detects a deleted entry", async () => {
    const chain = await buildChain(5);
    chain.splice(1, 1);
    const result = await verifyAuditChain(chain);
    expect(result).toMatchObject({ ok: false, brokenAtSeq: 2 });
  });

  it("detects a re-linked chain", async () => {
    const chain = await buildChain(3);
    chain[1] = { ...chain[1]!, prevHash: "f".repeat(64) };
    const result = await verifyAuditChain(chain);
    expect(result).toMatchObject({ ok: false, brokenAtSeq: 2, reason: "Previous-hash link does not match" });
  });

  it("verifies from a checkpoint", async () => {
    const chain = await buildChain(6);
    const result = await verifyAuditChain(chain.slice(3), chain[2]!.hash, 4);
    expect(result.ok).toBe(true);
  });

  it("scrubs secrets from audit data", () => {
    expect(
      scrubAuditData({ email: "a@b.c", password: "x", nested: [{ apiKey: "k", tokenHash: "h" }], at: new Date(0) }),
    ).toEqual({ email: "a@b.c", password: "[redacted]", nested: [{ apiKey: "[redacted]", tokenHash: "[redacted]" }], at: "1970-01-01T00:00:00.000Z" });
    expect(scrubAuditData(null)).toBeNull();
    expect(scrubAuditData(3)).toBe(3);
  });
});

describe("free-tier usage", () => {
  it("levels at 70 / 90 / 100 percent", () => {
    expect(usageLevel(null)).toBe("ok");
    expect(usageLevel(6_999)).toBe("ok");
    expect(usageLevel(7_000)).toBe("warn");
    expect(usageLevel(9_000)).toBe("critical");
    expect(usageLevel(10_000)).toBe("exceeded");
  });

  it("evaluates readings against limits", () => {
    const s = evaluateUsage({ key: "resend.daily", used: 71 });
    expect(s.bps).toBe(7_100);
    expect(s.level).toBe("warn");
    expect(evaluateUsage({ key: "vercel.credit", used: null })).toMatchObject({ bps: null, level: "ok" });
    expect(evaluateUsage({ key: "neon.storage", used: -5 }).bps).toBe(0);
  });

  it("alerts once per level, escalating", () => {
    const warn = evaluateUsage({ key: "resend.daily", used: 75 });
    const crit = evaluateUsage({ key: "resend.daily", used: 95 });
    const ok = evaluateUsage({ key: "neon.storage", used: 1 });
    expect(alertsToSend([warn, ok], {})).toEqual([warn]);
    expect(alertsToSend([warn], { "resend.daily": "warn" })).toEqual([]);
    expect(alertsToSend([crit], { "resend.daily": "warn" })).toEqual([crit]);
    expect(alertsToSend([warn], { "resend.daily": "critical" })).toEqual([]);
  });

  it("period keys reset daily/monthly", () => {
    expect(periodKey("day", "2026-09-23")).toBe("2026-09-23");
    expect(periodKey("month", "2026-09-23")).toBe("2026-09");
    expect(periodKey("total", "2026-09-23")).toBe("total");
  });

  it("formats", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.50 KB");
    expect(formatBytes(FREE_TIER_LIMITS["neon.storage"].limit)).toBe("512 MB");
    expect(formatBytes(10 * 1024 ** 3)).toBe("10.0 GB");
    expect(formatUsage(null, "bytes")).toBe("Not connected");
    expect(formatUsage(2000, "minutes")).toBe("2,000");
    expect(formatUsage(2048, "bytes")).toBe("2.00 KB");
  });

  it("GitHub bills whole minutes per job", () => {
    expect(billableMinutes(0)).toBe(0);
    expect(billableMinutes(1)).toBe(1);
    expect(billableMinutes(60)).toBe(1);
    expect(billableMinutes(61)).toBe(2);
  });
});

describe("upload guard", () => {
  it("refuses uploads that would cross 95% of the Blob budget", async () => {
    const { uploadAllowed, FREE_TIER_LIMITS: L } = await import("@/core/freeTier");
    const limit = L["blob.storage"].limit;
    expect(uploadAllowed(0, 1024)).toBe(true);
    expect(uploadAllowed(limit * 0.94, limit * 0.009)).toBe(true);
    expect(uploadAllowed(limit * 0.94, limit * 0.02)).toBe(false);
    expect(uploadAllowed(limit, 1)).toBe(false);
  });
  it("formats cents", async () => {
    const { formatUsage } = await import("@/core/freeTier");
    expect(formatUsage(1234, "cents")).toBe("$12.34");
  });
});
