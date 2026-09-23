import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.use({ viewport: { width: 393, height: 852 } });

test("iPhone: sign in, bottom tab bar, settings and sign out", async ({ page }) => {
  await signIn(page, "ariel@demo.test");
  await expect(page).toHaveURL(/\/tasks/);
  const tabbar = page.getByRole("navigation", { name: "Main" }).last();
  await expect(tabbar).toBeVisible();
  await tabbar.getByRole("link", { name: "Portfolio" }).click();
  await expect(page.getByText("Sterling Place Townhouse")).toBeVisible();
  await tabbar.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
});
