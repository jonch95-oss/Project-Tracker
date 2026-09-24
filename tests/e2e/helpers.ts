import { expect, type Page } from "@playwright/test";

export const PASSWORD = "demo password 1";

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // Signed in and landed: "/" always sends people on to their start page, so wait until that's done too.
  await page.waitForURL((u) => !u.pathname.startsWith("/login") && u.pathname !== "/");
}
