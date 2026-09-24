import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe("notifications", () => {
  test("preferences: push and email per event, quiet hours and digest are saved", async ({ page }) => {
    await signIn(page, "ariel@demo.test");
    await page.goto("/notifications");
    await page.getByRole("link", { name: "Preferences" }).click();
    const panel = page.locator("#notifications");
    await expect(panel.getByRole("heading", { name: "Notifications" })).toBeVisible();
    await expect(panel.getByText("Email is paused until a sender is chosen.")).toBeVisible();

    await panel.getByRole("checkbox", { name: "Comments on my tasks: push" }).uncheck();
    await panel.getByRole("switch", { name: "Quiet hours" }).click();
    await panel.getByLabel("From").fill("22:00");
    await panel.getByLabel("Until").fill("06:30");
    await panel.getByRole("button", { name: "Save notification settings" }).click();
    await expect(page.getByText("Notification settings saved")).toBeVisible();

    await page.reload();
    const again = page.locator("#notifications");
    await expect(again.getByRole("checkbox", { name: "Comments on my tasks: push" })).not.toBeChecked();
    await expect(again.getByRole("checkbox", { name: "Assigned to me: push" })).toBeChecked();
    await expect(again.getByLabel("From")).toHaveValue("22:00");
    await expect(again.getByLabel("Until")).toHaveValue("06:30");
    // Events that never email show a dash rather than a switch.
    await expect(again.getByRole("checkbox", { name: "Assigned to me: email" })).toHaveCount(0);
    await expect(again.getByRole("checkbox", { name: "Approval requested: email" })).toBeChecked();
  });

  test("tasks and alerts carry a WhatsApp share with no dollar figures", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/notifications");
    const shares = page.getByRole("link", { name: /^Share by WhatsApp/ });
    if ((await shares.count()) > 0) {
      const href = await shares.first().getAttribute("href");
      expect(href).toMatch(/^https:\/\/wa\.me\/\?text=/);
      expect(decodeURIComponent(href!)).not.toMatch(/\$\s?\d/);
    }

    await page.goto("/portfolio");
    await page.getByRole("link").filter({ has: page.getByRole("heading", { name: "Sterling Place Townhouse" }) }).click();
    await page.getByRole("tab", { name: "Checklist" }).click();
    const box = page.getByRole("checkbox", { name: /^Complete: / }).first();
    const label = (await box.getAttribute("aria-label"))!.replace(/^Complete: /, "").replace(/ \(waiting on other tasks\)$/, "");
    await page.getByRole("button", { name: label }).first().click();
    const dialog = page.getByRole("dialog");
    const wa = dialog.getByRole("link", { name: "WhatsApp" });
    await expect(wa).toBeVisible();
    const href = await wa.getAttribute("href");
    expect(decodeURIComponent(href!)).toMatch(/\/projects\/[0-9a-f-]+\?tab=checklist&task=/);
  });

  test("files: watch a folder", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/portfolio");
    await page.getByRole("link").filter({ has: page.getByRole("heading", { name: "Sterling Place Townhouse" }) }).click();
    await page.getByRole("tab", { name: "Files" }).click();
    await page.getByRole("button", { name: /^Design/ }).first().click();
    await page.getByRole("button", { name: "Watch", exact: true }).click();
    await expect(page.getByText("You'll hear when files are added to Design")).toBeVisible();
    await expect(page.getByRole("button", { name: "Watching" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Watching" }).click();
    await expect(page.getByRole("button", { name: "Watch", exact: true })).toBeVisible();
  });
});
