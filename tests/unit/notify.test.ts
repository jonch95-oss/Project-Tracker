import { describe, expect, it } from "vitest";
import { channelOn, inQuietHours, isHHMM, overdueNudge, safeOutsideText, whatsappUrl } from "@/core/notify";

describe("notification rules", () => {
  it("channels: in-app and push on by default, email only where the brief sends it", () => {
    expect(channelOn({}, "assigned", "push")).toBe(true);
    expect(channelOn({}, "assigned", "email")).toBe(false);
    expect(channelOn({}, "approval_requested", "email")).toBe(true);
    expect(channelOn({ assigned: { push: false } }, "assigned", "push")).toBe(false);
  });

  it("times are HH:MM on a 24-hour clock", () => {
    expect(isHHMM("00:00")).toBe(true);
    expect(isHHMM("23:59")).toBe(true);
    expect(isHHMM("24:00")).toBe(false);
    expect(isHHMM("7:00")).toBe(false);
    expect(isHHMM("")).toBe(false);
    expect(inQuietHours(60, "bad", "07:00")).toBe(false);
  });

  it("quiet hours, including across midnight", () => {
    expect(inQuietHours(23 * 60, "21:00", "07:00")).toBe(true);
    expect(inQuietHours(6 * 60 + 59, "21:00", "07:00")).toBe(true);
    expect(inQuietHours(7 * 60, "21:00", "07:00")).toBe(false);
    expect(inQuietHours(13 * 60, "12:00", "14:00")).toBe(true);
    expect(inQuietHours(13 * 60, null, null)).toBe(false);
    expect(inQuietHours(13 * 60, "12:00", "12:00")).toBe(false);
  });

  it("never puts a dollar figure outside the app", () => {
    expect(safeOutsideText("Approve the $1,250,000.50 invoice")).toBe("Approve the an amount invoice");
    expect(safeOutsideText("CO for $85K and $1.2M")).toBe("CO for an amount and an amount");
    expect(safeOutsideText("Unit 3A at $ 2 million")).toBe("Unit 3A at an amount");
    expect(safeOutsideText("Plans v2 ready")).toBe("Plans v2 ready");
    expect(safeOutsideText("Credit ($5,000) applied, -$20 fee")).toBe("Credit an amount applied, an amount fee");
    expect(decodeURIComponent(whatsappUrl("Paid $500", "https://x/y"))).not.toMatch(/\$/);
    expect(whatsappUrl("Hi", "https://x/y")).toMatch(/^https:\/\/wa\.me\/\?text=Hi%0Ahttps/);
  });

  it("overdue nudges every 2 days; the third copies the owner; re-dating restarts", () => {
    const base = { dueOn: "2026-09-01", status: "in_progress", nudgeCount: 0, nudgedForDue: null, lastNudgedOn: null };
    expect(overdueNudge(base, "2026-09-02")).toEqual({ count: 1, copyOwner: false });
    const one = { ...base, nudgeCount: 1, nudgedForDue: "2026-09-01", lastNudgedOn: "2026-09-02" };
    expect(overdueNudge(one, "2026-09-03")).toBeNull();
    expect(overdueNudge(one, "2026-09-04")).toEqual({ count: 2, copyOwner: false });
    expect(overdueNudge({ ...one, nudgeCount: 2, lastNudgedOn: "2026-09-04" }, "2026-09-06")).toEqual({ count: 3, copyOwner: true });
    expect(overdueNudge({ ...one, nudgeCount: 3, lastNudgedOn: "2026-09-06" }, "2026-09-08")).toEqual({ count: 4, copyOwner: false });
    // Re-dated: the count starts again.
    expect(overdueNudge({ ...one, dueOn: "2026-09-05", nudgeCount: 3 }, "2026-09-06")).toEqual({ count: 1, copyOwner: false });
    expect(overdueNudge({ ...base, status: "done" }, "2026-09-10")).toBeNull();
    expect(overdueNudge({ ...base, dueOn: "2026-09-10" }, "2026-09-10")).toBeNull();
  });
});
