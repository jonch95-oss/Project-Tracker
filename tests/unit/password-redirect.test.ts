import { describe, expect, it } from "vitest";
import { passwordProblem } from "@/core/password";
import { safeNextPath } from "@/core/redirect";

describe("password rule", () => {
  it.each([
    ["short1", "Use at least 12 characters."],
    ["onlyletterslong", "Mix letters with numbers or symbols."],
    ["123456789012345", "Mix letters with numbers or symbols."],
    ["x".repeat(257) + "1", "Use at most 256 characters."],
  ])("%s → %s", (pw, msg) => expect(passwordProblem(pw)).toBe(msg));
  it("accepts a passphrase", () => expect(passwordProblem("brooklyn brownstone 4")).toBeNull());
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
