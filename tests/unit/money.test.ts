import { describe, expect, it } from "vitest";
import {
  add,
  allocate,
  applyBasisPoints,
  assertCents,
  equityMultipleMilli,
  formatBasisPoints,
  formatMoney,
  formatMoneyCompact,
  formatMultiple,
  MoneyError,
  parseMoney,
  ratioBasisPoints,
  roundDiv,
  subtract,
  sum,
} from "@/core/money";

describe("parseMoney", () => {
  it.each([
    ["1250000", 125_000_000],
    ["$1,250,000.50", 125_000_050],
    ["1,250,000.5", 125_000_050],
    ["0.07", 7],
    ["  42 ", 4_200],
    ["-300", -30_000],
    ["(1,200.00)", -120_000],
    ["-$5.25", -525],
    ["12.", 1_200],
  ])("%s → %d cents", (input, cents) => {
    expect(parseMoney(input)).toBe(cents);
  });

  it.each(["", "abc", "1.234", "1,2,3.4.5", "$", "--5", "1e6"])("rejects %j", (input) => {
    expect(() => parseMoney(input)).toThrow(MoneyError);
  });

  it("rejects values beyond safe integer cents", () => {
    expect(() => parseMoney("999999999999999999")).toThrow(MoneyError);
  });
});

describe("formatMoney", () => {
  it("formats cents without floating point", () => {
    expect(formatMoney(125_000_050)).toBe("$1,250,000.50");
    expect(formatMoney(7)).toBe("$0.07");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(-525)).toBe("-$5.25");
  });
  it("rounds to whole dollars half away from zero", () => {
    expect(formatMoney(150, { whole: true })).toBe("$2");
    expect(formatMoney(149, { whole: true })).toBe("$1");
    expect(formatMoney(-150, { whole: true })).toBe("-$2");
  });
  it("compact formats", () => {
    expect(formatMoneyCompact(425_000_000)).toBe("$4.25M");
    expect(formatMoneyCompact(400_000_000)).toBe("$4M");
    expect(formatMoneyCompact(85_000_000)).toBe("$850K");
    expect(formatMoneyCompact(99_900)).toBe("$999");
    expect(formatMoneyCompact(-150_000_000)).toBe("-$1.5M");
  });
  it("refuses non-integer input", () => {
    expect(() => formatMoney(1.5)).toThrow(MoneyError);
  });
});

describe("arithmetic", () => {
  it("adds and subtracts integers", () => {
    expect(add(1, 2, 3)).toBe(6);
    expect(sum([])).toBe(0);
    expect(subtract(10, 25)).toBe(-15);
  });
  it("detects overflow", () => {
    expect(() => sum([Number.MAX_SAFE_INTEGER, 1])).toThrow(MoneyError);
    expect(() => subtract(-Number.MAX_SAFE_INTEGER, 1)).toThrow(MoneyError);
  });
  it("assertCents rejects NaN and floats", () => {
    expect(() => assertCents(Number.NaN)).toThrow();
    expect(() => assertCents(0.1)).toThrow();
  });
});

describe("rounding", () => {
  it("roundDiv rounds half away from zero", () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(-5, 2)).toBe(-3);
    expect(roundDiv(4, 3)).toBe(1);
    expect(roundDiv(-4, 3)).toBe(-1);
    expect(roundDiv(0, 7)).toBe(0);
    expect(roundDiv(-1, 3)).toBe(0);
    expect(roundDiv(5, -2)).toBe(-3);
  });
  it("roundDiv validates", () => {
    expect(() => roundDiv(1, 0)).toThrow(MoneyError);
    expect(() => roundDiv(1.5, 2)).toThrow(MoneyError);
  });
  it("applies basis points", () => {
    expect(applyBasisPoints(1_000_000, 500)).toBe(50_000); // 5% retainage
    expect(applyBasisPoints(333, 5_000)).toBe(167); // 166.5 → 167
    expect(applyBasisPoints(-333, 5_000)).toBe(-167);
    expect(() => applyBasisPoints(100, 1.5)).toThrow(MoneyError);
  });
  it("computes ratios in basis points", () => {
    expect(ratioBasisPoints(1, 3)).toBe(3_333);
    expect(ratioBasisPoints(2, 3)).toBe(6_667);
    expect(ratioBasisPoints(-50, 200)).toBe(-2_500);
    expect(ratioBasisPoints(5, 0)).toBeNull();
    expect(formatBasisPoints(2_150)).toBe("21.5%");
    expect(formatBasisPoints(null)).toBe("—");
  });
});

describe("allocate", () => {
  it("always sums to the total", () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(parts).toEqual([34, 33, 33]);
    expect(parts.reduce((a, b) => a + b)).toBe(100);
  });
  it("distributes remainders by largest remainder", () => {
    expect(allocate(1_000, [70, 20, 10])).toEqual([700, 200, 100]);
    expect(allocate(10, [3, 3, 4])).toEqual([3, 3, 4]);
    expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(allocate(5, [0, 1])).toEqual([0, 5]);
  });
  it("validates weights", () => {
    expect(() => allocate(100, [])).toThrow(MoneyError);
    expect(() => allocate(100, [0, 0])).toThrow(MoneyError);
    expect(() => allocate(100, [-1, 2])).toThrow(MoneyError);
    expect(() => allocate(100, [0.5, 1])).toThrow(MoneyError);
  });
  it("property: random allocations are exact", () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 500; i++) {
      const total = Math.floor(rand() * 10_000_000_000) - 5_000_000_000;
      const weights: number[] = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => Math.floor(rand() * 1000));
      if (!weights.some((w) => w > 0)) weights[0] = 1;
      const parts = allocate(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});

describe("equity multiple", () => {
  it("computes thousandths", () => {
    expect(equityMultipleMilli(185_000_000, 100_000_000)).toBe(1_850);
    expect(equityMultipleMilli(1, 3)).toBe(333);
    expect(equityMultipleMilli(100, 0)).toBeNull();
    expect(formatMultiple(1_850)).toBe("1.85x");
    expect(formatMultiple(null)).toBe("—");
  });
  it("handles large values without overflow", () => {
    expect(equityMultipleMilli(9_000_000_000_000, 3_000_000_000_000)).toBe(3_000);
  });
});
