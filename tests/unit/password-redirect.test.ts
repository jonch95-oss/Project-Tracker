import { describe, expect, it } from "vitest";
import { passwordProblem } from "@/core/password";
import { safeNextPath } from "@/core/redirect";

describe("password rule", () => {
  it.each([
    ["short1", "Use at least 10 characters."],
    ["Lian$123@", "Use at least 10 characters."],
    ["onlyletterslong", "Mix letters with numbers or symbols."],
    ["123456789012345", "Mix letters with numbers or symbols."],
    ["x".repeat(257) + "1", "Use at most 256 characters."],
  ])("%s → %s", (pw, msg) => expect(passwordProblem(pw)).toBe(msg));
  it("accepts a passphrase", () => expect(passwordProblem("brooklyn brownstone 4")).toBeNull());
  it("accepts ten characters mixing letters and symbols", () => expect(passwordProblem("Lian$1234@")).toBeNull());
});

describe("safeNextPath", () => {
  it.each([
    ["/projects/abc?tab=team", "/projects/abc?tab=team"],
    [null, "/"],
    ["", "/"],
    ["//evil.com", "/"],
    ["https://evil.com", "/"],
    ["/\\evil.com", "/"],
    ["relative", "/"],
    ["/login?next=/x", "/"],
    ["/ok\u0000", "/"],
  ])("%j → %s", (input, out) => expect(safeNextPath(input as string | null)).toBe(out));
});
