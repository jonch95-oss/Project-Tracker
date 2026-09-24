import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe("tasks", () => {
  test("owner: Needs-you rail, approve from the rail, add a key date, bulk shift", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/portfolio");
    const rail = page.getByRole("region", { name: "Needs you" });
    await expect(rail.getByRole("heading", { name: "Needs you" })).toBeVisible();
    await expect(rail.getByRole("heading", { name: /^Blocked/ })).toBeVisible();
    await expect(rail.getByRole("heading", { name: /^Key dates, next 14 days/ })).toBeVisible();
    const approvals = rail.getByRole("heading", { name: /^Waiting on your approval/ });
    await expect(approvals).toBeVisible();
    const before = await rail.getByRole("button", { name: "Approve" }).count();
    await rail.getByRole("button", { name: "Approve" }).first().click();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
    await expect(rail.getByRole("button", { name: "Approve" })).toHaveCount(before - 1);

    // Cards carry the next action, blockers and the next key date.
    const card = page.getByRole("link").filter({ has: page.getByRole("heading", { name: "Sterling Place Townhouse" }) });
    await expect(card.getByText("Next action")).toBeVisible();
    await expect(card.getByText(/1 blocked/)).toBeVisible();

    // Key dates tab.
    await card.click();
    await page.getByRole("tab", { name: "Key Dates" }).click();
    await page.getByRole("button", { name: "Add date" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("What").selectOption("closing");
    await d.getByLabel("Date", { exact: true }).fill("2031-03-14");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Date added")).toBeVisible();
    await expect(page.getByRole("button", { name: /Closing/ })).toBeVisible();

    // Bulk: select two tasks and push them a week.
    await page.getByRole("tab", { name: "Checklist" }).click();
    await page.getByRole("button", { name: "Select", exact: true }).click();
    const boxes = page.getByRole("checkbox", { name: /^Select / });
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    const bar = page.getByRole("region", { name: "Bulk actions" });
    await expect(bar.getByText("2 selected")).toBeVisible();
    await bar.getByRole("button", { name: "Shift" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText(/tasks? updated/)).toBeVisible();
  });

  test("team member: My Tasks, waiting on a third party, @mention, and the mention lands in the inbox", async ({ browser }) => {
    const ariel = await browser.newPage();
    await signIn(ariel, "ariel@demo.test");
    await ariel.goto("/tasks");
    await expect(ariel.getByRole("heading", { name: "My Tasks" })).toBeVisible();
    await expect(ariel.getByRole("heading", { name: /^Overdue|^Today|^This week|^Later/ }).first()).toBeVisible();
    await expect(ariel.getByRole("heading", { name: /Waiting on others/ })).toBeVisible();

    // Open the first task in "Later" or "This week" and mark it waiting.
    const first = ariel.locator("section").filter({ has: ariel.getByRole("heading", { name: /^(This week|Later)/ }) }).getByRole("link").filter({ hasText: /Due|late/ }).first();
    const title = (await first.locator("span").first().textContent())!.trim();
    await first.click();
    await expect(ariel).toHaveURL(/task=/);
    const td = ariel.getByRole("dialog");
    await expect(td.getByRole("heading", { name: title })).toBeVisible();
    await td.getByRole("radio", { name: "Waiting" }).click();
    await td.getByLabel("Who are you waiting on?").fill("Expediter — DOB plan exam");
    await td.getByRole("button", { name: "Save", exact: true }).click();
    await expect(td.getByText(/Waiting on Expediter — DOB plan exam/)).toBeVisible();

    // Comment with an @mention picked from the list.
    const box = td.getByLabel("Write a comment");
    await box.fill("Filed today, ");
    await box.pressSequentially("@Eli");
    await td.getByRole("listbox").getByRole("option", { name: /Elias Ariel/ }).click();
    await box.pressSequentially("can you chase the examiner?");
    await td.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(td.getByText("@Elias Ariel", { exact: true })).toBeVisible();

    // Elias gets it in the inbox and it opens the task.
    const elias = await browser.newPage();
    await signIn(elias, "elias@demo.test");
    await elias.goto("/notifications");
    const n = elias.getByRole("link", { name: /Ariel Cohen mentioned you/ }).first();
    await expect(n).toBeVisible();
    await n.click();
    await expect(elias).toHaveURL(/task=/);
    await expect(elias.getByRole("dialog").getByRole("heading", { name: title })).toBeVisible();
  });
});
