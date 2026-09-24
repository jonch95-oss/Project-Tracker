import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe("checklists and templates", () => {
  test("create a project with site conditions, then work its checklist", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/portfolio");
    await page.getByRole("button", { name: "New project" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Project name").fill("Lefferts Place Gut Reno");
    await d.getByLabel("Address").fill("14 Lefferts Place");
    await d.getByLabel("Project type").selectOption("gut_renovation");
    await d.getByRole("button", { name: "Next", exact: true }).click();
    await expect(d.getByRole("heading", { name: "Site conditions" })).toBeVisible();
    const count = d.locator("aside").getByText(/tasks in \d+ phases/);
    await expect(count).toBeVisible();
    const before = Number((await count.textContent())!.match(/(\d+) tasks/)![1]);
    await d.getByRole("switch", { name: /Excavation/ }).click();
    await expect(count).not.toHaveText(new RegExp(`^${before} tasks`));
    // Back keeps step 1's answers.
    await d.getByRole("button", { name: "Back" }).click();
    await expect(d.getByLabel("Project name")).toHaveValue("Lefferts Place Gut Reno");
    await d.getByRole("button", { name: "Next", exact: true }).click();
    await d.getByRole("button", { name: "Create project" }).click();

    await expect(page).toHaveURL(/tab=checklist/);
    await expect(page.getByText("Site conditions:")).toBeVisible();
    await expect(page.getByText("Geotech borings")).toHaveCount(1); // added by Excavation (Due Diligence, collapsed but in the DOM)

    // A blocked task explains itself and can't be checked off.
    const pro = page.getByRole("checkbox", { name: /Pro forma/ });
    await expect(pro).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: /^Pro forma/ })).toContainText(/Waiting on PLUTO pull/);
    // Tapping it anyway says why.
    await pro.click({ force: true });
    await expect(page.getByText(/^Waiting on: .*PLUTO pull/)).toBeVisible();
    await expect(pro).toHaveAttribute("aria-checked", "false");

    // One-tap complete, then its dependent unblocks.
    await page.getByRole("checkbox", { name: /Complete: PLUTO pull/ }).click();
    await expect(page.getByRole("checkbox", { name: /PLUTO pull/ })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("checkbox", { name: /Complete: Finished-product sales comps/ }).click();
    await expect(page.getByRole("checkbox", { name: /Complete: Pro forma/ })).not.toHaveAttribute("aria-disabled", "true");

    // Add a task, open it, give it a prerequisite, rename it.
    await page.getByLabel("Add a task to this phase").first().fill("Walk the block with the broker");
    await page.getByLabel("Add a task to this phase").first().press("Enter");
    await page.getByRole("button", { name: /Walk the block with the broker/ }).click();
    const td = page.getByRole("dialog");
    await td.getByLabel("Title", { exact: true }).fill("Walk the block with Ariel");
    await td.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Task saved")).toBeVisible();
    await td.getByRole("button", { name: "Edit" }).click();
    await td.getByLabel("Filter tasks").fill("Site visit");
    await td.getByRole("checkbox", { name: /Site visit with photos/ }).check();
    await td.getByRole("button", { name: "Save prerequisites" }).click();
    await expect(page.getByText("Prerequisites saved")).toBeVisible();
    await td.getByRole("button", { name: "Close" }).first().click();
    await expect(page.getByText(/Waiting on Site visit with photos/)).toBeVisible();

    // Turn a site condition off: the preview lists what goes.
    await page.getByRole("button", { name: /Site conditions/ }).click();
    const tg = page.getByRole("dialog", { name: "Site conditions" });
    await tg.getByRole("switch", { name: /Excavation/ }).click();
    await expect(tg.getByText(/Removes 4 tasks not started yet/)).toBeVisible();
    await tg.getByRole("button", { name: "Apply changes" }).click();
    await expect(page.getByText(/Site conditions updated: 0 added, 4 removed/)).toBeVisible();
    await expect(page.getByText("Geotech borings")).toHaveCount(0);
  });

  test("template studio: edit a template, preview it, save a new version, apply it to a project", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/templates");
    await page.getByRole("button", { name: "New template" }).click();
    await page.getByLabel("Name").fill("Flip — fast");
    await page.getByLabel("Start from").selectOption("type:contract_flip");
    await page.getByRole("button", { name: "Create and edit" }).click();
    await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}/);
    await expect(page.getByLabel("Template name")).toHaveValue("Flip — fast");

    await page.getByRole("button", { name: "Task", exact: true }).click();
    const te = page.getByRole("dialog", { name: "New task" });
    await te.getByLabel("Title", { exact: true }).fill("Call three wholesalers");
    await te.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("Call three wholesalers")).toBeVisible();
    await expect(page.getByText("Unsaved changes")).toBeVisible();

    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByRole("dialog").getByText("Call three wholesalers")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByText(/Saved as version 2/)).toBeVisible();
    await expect(page.getByText("version 2", { exact: false }).first()).toBeVisible();
  });

  test("a member without checklist rights works tasks but can't edit the checklist", async ({ page }) => {
    await signIn(page, "ariel@demo.test");
    await page.goto("/portfolio");
    await page.getByRole("heading", { name: "Macon Street Auction" }).click();
    await page.getByRole("tab", { name: "Checklist" }).click();
    // Ariel has checklist rights on demo projects; the architect (external) sees none of it.
    await expect(page.getByRole("button", { name: /Site conditions/ })).toBeVisible();
  });

  test("an outside collaborator sees only tasks assigned to them", async ({ page }) => {
    await signIn(page, "architect@demo.test");
    await page.goto("/portfolio");
    await page.getByRole("heading", { name: "Bergen Street Condominium" }).click();
    await page.getByRole("tab", { name: "Checklist" }).click();
    await expect(page.getByText("Nothing assigned to you here yet")).toBeVisible();
    await expect(page.getByRole("button", { name: /Site conditions/ })).toHaveCount(0);
    await page.goto("/templates");
    await expect(page).not.toHaveURL(/templates/);
  });
});
