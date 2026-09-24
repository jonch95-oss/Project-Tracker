import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.use({ viewport: { width: 393, height: 852 } });

test("iPhone: sign in, bottom tab bar, settings and sign out", async ({ page }) => {
  await signIn(page, "ariel@demo.test");
  await expect(page).toHaveURL(/\/tasks/);
  const tabbar = page.getByRole("navigation", { name: "Main" }).last();
  await expect(tabbar).toBeVisible();
  await tabbar.getByRole("link", { name: "Portfolio" }).click();
  await expect(page.getByRole("heading", { name: "Sterling Place Townhouse" })).toBeVisible();
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
