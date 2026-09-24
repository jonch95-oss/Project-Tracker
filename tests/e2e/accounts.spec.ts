import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const DB_URL = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/pc_e2e_test";

function createAccount(username: string, name: string, password: string) {
  execSync("npx tsx --conditions=react-server scripts/create-account.ts", {
    env: { ...process.env, DATABASE_URL: DB_URL, ACCOUNT_NAME: name, ACCOUNT_USERNAME: username, ACCOUNT_ROLE: "admin", ACCOUNT_PASSWORD: password },
    stdio: "pipe",
  });
}

test("a username with a temporary password signs in, must choose their own, then works normally", async ({ page }, testInfo) => {
  const username = `temp_${testInfo.project.name.replace(/\W/g, "")}_${Date.now() % 100000}`;
  createAccount(username, "Temp Admin", "Lian$1234@");

  await page.goto("/login");
  await page.getByLabel("Email or username").fill(username.toUpperCase());
  await page.getByLabel("Password").fill("Lian$1234@");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/change-password/);
  await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();

  // Nothing else opens until they do.
  await page.goto("/portfolio");
  await expect(page).toHaveURL(/\/change-password/);

  await page.getByLabel("Temporary password").fill("Lian$1234@");
  await page.getByLabel("New password", { exact: true }).fill("my own site password 7");
  await page.getByLabel("New password again").fill("my own site password 7");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/portfolio/);
  await expect(page.getByRole("heading", { level: 1, name: "Portfolio" })).toBeVisible();
});

test("a wrong username or password says so without revealing which", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email or username").fill("nobody_here");
  await page.getByLabel("Password").fill("Lian$1234@");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("That sign-in name and password don't match.")).toBeVisible();
});
