import { describe, expect, it } from "vitest";
import { carryForward, clamp01, isActiveSiteDay, manpowerTotal, parseOpenMeteo, sheetNumberFromName, weatherSummary } from "@/core/field";

describe("field helpers", () => {
  it("weather", () => {
    expect(weatherSummary(0)).toBe("Clear");
    expect(weatherSummary(63)).toBe("Rain");
    expect(weatherSummary(999)).toBe("Unknown");
    expect(weatherSummary(null)).toBe("Unknown");
    const body = { daily: { time: ["2026-09-23", "2026-09-24"], weather_code: [3, 61], temperature_2m_max: [70.24, 66.1], temperature_2m_min: [55, 58], precipitation_sum: [0, 0.42], wind_speed_10m_max: [9, 14.66] } };
    expect(parseOpenMeteo(body, "2026-09-24")).toEqual({ summary: "Rain", highF: 66.1, lowF: 58, precipIn: 0.4, windMph: 14.7 });
    expect(parseOpenMeteo(body, "2026-09-25")).toBeNull();
    expect(parseOpenMeteo({}, "2026-09-24")).toBeNull();
    expect(parseOpenMeteo({ daily: { time: ["2026-09-24"], weather_code: ["x"] } }, "2026-09-24")!.summary).toBe("Unknown");
  });

  it("active site days, manpower, carry-forward, sheet numbers", () => {
    expect(isActiveSiteDay("construction", "2026-09-24")).toBe(true); // Thursday
    expect(isActiveSiteDay("construction", "2026-09-26")).toBe(false); // Saturday
    expect(isActiveSiteDay("design_zoning", "2026-09-24")).toBe(false);
    expect(isActiveSiteDay(null, "2026-09-24")).toBe(false);
    expect(manpowerTotal([{ count: 4 }, { count: 2.6 }, { count: -1 }, { count: Number.NaN }])).toBe(7);
    expect(carryForward([{ kind: "action", status: "open" }, { kind: "action", status: "closed" }, { kind: "note", status: "open" }])).toHaveLength(1);
    expect(sheetNumberFromName("A-101 Floor Plans.pdf")).toBe("A-101");
    expect(sheetNumberFromName("s201.pdf")).toBe("S201");
    expect(sheetNumberFromName("Cover sheet.pdf")).toBe("COVER SHEET");
    expect(clamp01(1.4)).toBe(1);
    expect(clamp01(-2)).toBe(0);
  });
});
