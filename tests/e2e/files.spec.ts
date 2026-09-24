import path from "node:path";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const fixture = (f: string) => path.join(__dirname, "fixtures", f);

test.describe("files", () => {
  test("upload into a folder, preview, new version, rename, trash and restore", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/portfolio");
    await page.getByRole("heading", { name: "Sterling Place Townhouse" }).click();
    await page.getByRole("tab", { name: "Files" }).click();
    const nav = page.getByRole("navigation", { name: "Folders" });
    await expect(nav.getByRole("button", { name: /Financial/ })).toBeVisible();
    await nav.getByRole("button", { name: /^Legal/ }).click();
    await page.locator('input[type="file"]').first().setInputFiles(fixture("contract.pdf"));
    await expect(page.getByText("File added")).toBeVisible();
    await page.getByRole("button", { name: /contract\.pdf/ }).click();
    const sheet = page.getByRole("dialog", { name: /contract/i });
    await expect(sheet.getByRole("heading", { name: "contract.pdf" })).toBeVisible();
    await expect(sheet.locator("iframe[title='Preview of contract.pdf']")).toBeVisible();
    // New version
    await sheet.locator('input[type="file"]').setInputFiles(fixture("contract.pdf"));
    await expect(page.getByText("New version uploaded")).toBeVisible();
    await expect(sheet.getByText("v2", { exact: true })).toBeVisible();
    // Rename
    await sheet.getByRole("button", { name: "Rename" }).click();
    await sheet.getByLabel("File name").fill("Contract of sale.pdf");
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet.getByRole("heading", { name: "Contract of sale.pdf" })).toBeVisible();
    // Trash and restore
    await sheet.getByRole("button", { name: "Remove" }).click();
    await page.getByRole("dialog", { name: "Move to the trash?" }).getByRole("button", { name: "Move to trash" }).click();
    await expect(page.getByText(/Moved to the trash/)).toBeVisible();
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    const trash = page.getByRole("dialog", { name: "Trash" });
    await trash.getByRole("button", { name: "Restore" }).first().click();
    await expect(page.getByText("Restored")).toBeVisible();
    await trash.getByRole("button", { name: "Close" }).first().click();
    await expect(page.getByRole("button", { name: /Contract of sale\.pdf/ })).toBeVisible();
  });

  test("a task that needs an attachment routes to the attach step; the outside architect sees only shared folders", async ({ page, browser }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/portfolio");
    await page.getByRole("heading", { name: "Halsey Street Assignment" }).click();
    await page.getByRole("tab", { name: "Checklist" }).click();
    // "Site visit with photos" needs site photos. Its phase is finished, so open it first.
    await page.getByRole("button", { name: /^Pipeline/ }).click();
    const box = page.getByRole("checkbox", { name: /Site visit with photos/ });
    if ((await box.getAttribute("aria-checked")) === "true") {
      // Reopen it (the seed finished this phase) and let that land first.
      const reopened = page.waitForResponse((r) => r.url().includes("checklist.setDone"));
      await box.click();
      await reopened;
    }
    await page.getByRole("checkbox", { name: /Complete: Site visit with photos/ }).click();
    await expect(page.getByText(/Attach Site photos first/)).toBeVisible();
    const td = page.getByRole("dialog", { name: /Site visit with photos/ });
    await expect(td.getByText(/Needs Site photos before it can be checked off/)).toBeVisible();
    await td.locator('#task-attachments input[type="file"]').setInputFiles(fixture("site.png"));
    await expect(page.getByText("Attached", { exact: true })).toBeVisible();
    await expect(td.getByRole("button", { name: /^site\.png/ })).toBeVisible();
    await td.getByRole("button", { name: "Mark done" }).click();
    await expect(page.getByRole("checkbox", { name: /Site visit with photos/ })).toHaveAttribute("aria-checked", "true");

    // Share Design with the architect.
    await td.getByRole("button", { name: "Close" }).first().click();
    await page.getByRole("tab", { name: "Files" }).click();
    await page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /^Design/ }).click();
    await page.getByRole("button", { name: "Share" }).click();
    const share = page.getByRole("dialog", { name: "Share Design" });
    await share.getByRole("button", { name: "Share", exact: true }).first().click();
    await expect(share.getByRole("button", { name: "Shared" })).toBeVisible();

    const arch = await browser.newPage();
    await signIn(arch, "architect@demo.test");
    await arch.goto("/portfolio");
    await arch.getByRole("heading", { name: "Halsey Street Assignment" }).click();
    await arch.getByRole("tab", { name: "Files" }).click();
    const folders = arch.getByRole("navigation", { name: "Folders" }).getByRole("button");
    await expect(folders).toHaveCount(1);
    await expect(folders.first()).toContainText("Design");
  });
});
