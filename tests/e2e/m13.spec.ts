import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe("search and the weekly report", () => {
  test("⌘K finds a project by name or BBL and opens it from the keyboard", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.keyboard.press("ControlOrMeta+k");
    const box = page.getByRole("combobox", { name: /Search projects/ });
    await expect(box).toBeFocused();
    // Nothing typed: the places to go.
    await expect(page.getByRole("option", { name: "Weekly report" })).toBeVisible();
    await box.fill("3-01137-0045");
    await expect(page.getByRole("option", { name: /Sterling Place Townhouse/ })).toBeVisible();
    await box.fill("Bergen");
    await expect(page.getByRole("option", { name: /Bergen Street Condominium/ }).first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: "Bergen Street Condominium" }).first()).toBeVisible();
    // "/" opens it too; Esc closes it.
    await page.locator("body").press("/");
    await expect(page.getByRole("combobox", { name: /Search projects/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("combobox", { name: /Search projects/ })).toBeHidden();
  });

  test("an outside collaborator's search stays inside what they can see", async ({ page }) => {
    await signIn(page, "architect@demo.test");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: /Search projects/ }).fill("Bergen");
    await expect(page.getByText(/Nothing matches|Bergen/).first()).toBeVisible();
    await expect(page.getByRole("option", { name: /People|Directory/ })).toHaveCount(0);
  });

  test("the owner reads the weekly report and downloads the PDF; a team member can't open it", async ({ page, browser }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/reports");
    await expect(page.getByRole("heading", { name: "Weekly report", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sterling Place Townhouse" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What's stuck" }).first()).toBeVisible();
    const pdf = await page.request.get("/api/export/reports/live");
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    const overflow = await page.setViewportSize({ width: 393, height: 852 }).then(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth));
    expect(overflow).toBeLessThanOrEqual(0);

    const other = await browser.newPage();
    await signIn(other, "ariel@demo.test");
    await other.goto("/reports");
    await expect(other).not.toHaveURL(/\/reports/);
    expect((await other.request.get("/api/export/reports/live")).status()).toBe(403);
    await other.close();
  });
});

test("the team guide opens without signing in and fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/guide");
  await expect(page.getByRole("heading", { name: "How to use Project Command" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Find anything" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Step-by-step pictures" })).toHaveAttribute("href", "/install");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
