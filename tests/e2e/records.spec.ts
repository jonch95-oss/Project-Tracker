import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe("public records and expiries", () => {
  test("owner: records tab, violation to a hearing date, task from an alert, expiries and the red flags", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/portfolio");
    const card = page.getByRole("link").filter({ has: page.getByRole("heading", { name: "Sterling Place Townhouse" }) });
    await expect(card.getByText("1 expired")).toBeVisible();
    await expect(card.getByText(/COI expired: Northside Scaffold/)).toBeVisible();
    await expect(card.getByText("1 open violation")).toBeVisible();
    const rail = page.getByRole("region", { name: "Needs you" });
    await expect(rail.getByRole("heading", { name: /^Public records/ })).toBeVisible();
    await expect(rail.getByRole("heading", { name: /^Expired/ })).toBeVisible();

    await card.click();
    await page.getByRole("tab", { name: "Public Records" }).click();
    await expect(page.getByRole("heading", { name: "Public records" })).toBeVisible();
    await expect(page.getByText(/BBL 3011370045 · last checked/)).toBeVisible();
    await expect(page.getByText("ACRIS open data lags the live system by one to two months: data as of", { exact: false })).toBeVisible();

    // Violation: move it along.
    const violations = page.getByRole("region", { name: "Violations" });
    await expect(violations.getByText("ECB violation 39000123K")).toBeVisible();
    await violations.getByRole("button", { name: "Update" }).first().click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Stage").selectOption("fixed");
    await dlg.getByLabel("Notes").fill("Shed repaired; photos filed");
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Violation updated")).toBeVisible();
    await expect(violations.getByText("Fixed", { exact: true })).toBeVisible();

    // Alert → task.
    const alerts = page.getByRole("region", { name: "Alerts" });
    await alerts.getByRole("button", { name: "Create task" }).first().click();
    await expect(page.getByText("Task created")).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("Follow up: New violation: ECB violation 39000123K");
    await page.keyboard.press("Escape");

    // Expiries on the dates tab.
    await page.getByRole("tab", { name: "Dates & Expiries" }).click();
    await expect(page.getByRole("heading", { name: "Expiries" })).toBeVisible();
    await expect(page.getByText(/Expired COI on file for Northside Scaffold/)).toBeVisible();
    await expect(page.getByText("Vendor COI: general liability: Northside Scaffold")).toBeVisible();
    await page.getByRole("button", { name: "Add expiry" }).click();
    const ed = page.getByRole("dialog");
    await ed.getByLabel("What").selectOption("umbrella");
    await ed.getByLabel("Expires").fill("2031-06-30");
    await ed.getByLabel("Name or number (optional)").fill("UMB-778");
    await ed.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Umbrella policy: UMB-778")).toBeVisible();
  });

  test("outside collaborators don't see the records or expiry tabs", async ({ page }) => {
    await signIn(page, "architect@demo.test");
    await page.goto("/portfolio");
    await page.getByRole("heading", { name: "Sterling Place Townhouse" }).click();
    await expect(page.getByRole("tab", { name: "Files" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Public Records" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Dates & Expiries" })).toHaveCount(0);
  });
});
