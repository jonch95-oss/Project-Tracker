import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

test.use({ viewport: { width: 393, height: 852 } });

test("iPhone: sign in, bottom tab bar, settings and sign out", async ({ page }) => {
  await signIn(page, "ariel@demo.test");
  await expect(page).toHaveURL(/\/tasks/);
  const tabbar = page.getByRole("navigation", { name: "Main" }).last();
  await expect(tabbar).toBeVisible();
  await tabbar.getByRole("link", { name: "Portfolio" }).click();
  await expect(page.getByRole("heading", { name: "Sterling Place Townhouse" })).toBeVisible();
  // Search has a tab of its own; Settings sits under More.
  await tabbar.getByRole("link", { name: "Search" }).click();
  await page.getByRole("combobox", { name: /Search projects/ }).fill("Sterling");
  await page.getByRole("option", { name: /Sterling Place Townhouse/ }).first().click();
  await expect(page).toHaveURL(/\/projects\//);
  await tabbar.getByRole("button", { name: "More" }).click();
  await tabbar.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("iPhone: portfolio cards, phase track and project page", async ({ page }) => {
  await signIn(page, "jon@demo.test");
  await page.goto("/portfolio");
  await expect(page.getByRole("heading", { name: "Bergen Street Condominium" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole("radio", { name: "Table" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("radio", { name: "Cards" }).click();
  await page.getByRole("heading", { name: "Bergen Street Condominium" }).click();
  await expect(page.getByRole("heading", { name: "Bergen Street Condominium" })).toBeVisible();
  await expect(page.locator('[aria-current="step"]')).toBeInViewport();
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow2).toBeLessThanOrEqual(0);
});

test("iPhone: checklist one-tap complete and task sheet", async ({ page }) => {
  await signIn(page, "elias@demo.test");
  await page.goto("/portfolio");
  await page.getByRole("heading", { name: "Sterling Place Townhouse" }).click();
  await page.getByRole("tab", { name: "Checklist" }).click();
  const open = page.getByRole("checkbox", { name: /^Complete: / }).first();
  const label = (await open.getAttribute("aria-label"))!.replace(/^Complete: /, "").replace(/ \(waiting on other tasks\)$/, "");
  if ((await open.getAttribute("aria-disabled")) !== "true") {
    await open.click();
    await expect(page.getByRole("checkbox", { name: `Reopen: ${label}` })).toBeVisible();
  }
  await page.getByRole("button", { name: label }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("iPhone: take a photo straight into the project's photos", async ({ page }) => {
  await signIn(page, "jon@demo.test");
  await page.goto("/portfolio");
  await page.getByRole("heading", { name: "Sterling Place Townhouse" }).click();
  await expect(page.getByRole("button", { name: "Take photo" })).toBeVisible();
  const before = await page.getByRole("button", { name: /^Open photo/ }).count();
  // A photo made just now (as the camera does), so it's stamped and timed as taken now.
  await page.getByLabel("Take a photo").setInputFiles({ name: "IMG_0001.png", mimeType: "image/png", buffer: readFileSync(path.join(__dirname, "fixtures", "site.png")) });
  await expect(page.getByText("Photo added")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /^Open photo/ })).toHaveCount(before + 1);
  // Taken just now, so it carries today's capture time.
  await expect(page.getByRole("button", { name: /^Open photo taken/ }).first()).toBeVisible();
});

test("iPhone: approve a request from My Tasks", async ({ page }) => {
  // Its own request, so the seeded one stays for the desktop approval test.
  const title = `iPhone approval ${Date.now()}`;
  const db = new Client({ connectionString: process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/pc_e2e_test" });
  await db.connect();
  await db.query(
    `insert into task (project_id, phase_key, title, status, requires_approval, approver_role, approver_id, approval_requested_at, due_on)
     select p.id, 'construction', $1, 'awaiting_approval', true, 'Owner', u.id, now(), current_date from project p, "user" u where p.name = 'Sterling Place Townhouse' and u.email = 'jon@demo.test'`,
    [title],
  );
  await db.end();
  await signIn(page, "jon@demo.test");
  await page.goto("/tasks");
  const approve = page.getByRole("listitem").filter({ hasText: title }).getByRole("button", { name: "Approve" });
  await expect(approve).toBeVisible();
  await approve.click();
  await expect(page.getByText("Approved")).toBeVisible();
});
