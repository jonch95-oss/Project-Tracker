import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe("authentication", () => {
  test("unauthenticated visitors are sent to sign in", async ({ page }) => {
    await page.goto("/portfolio");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("wrong password shows a clear message", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("jon@demo.test");
    await page.getByLabel("Password").fill("not the password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("#password-error")).toContainText("don't match");
  });

  test("owner lands on Portfolio; member lands on My Tasks", async ({ page, context }) => {
    await signIn(page, "jon@demo.test");
    await expect(page).toHaveURL(/\/portfolio/);
    await expect(page.getByText("Sterling Place Townhouse")).toBeVisible();
    await context.clearCookies();
    await signIn(page, "ariel@demo.test");
    await expect(page).toHaveURL(/\/tasks/);
  });
});

test.describe("roles", () => {
  test("non-owners cannot open owner pages", async ({ page }) => {
    await signIn(page, "elias@demo.test");
    for (const path of ["/team", "/system", "/audit"]) {
      await page.goto(path);
      await expect(page).not.toHaveURL(new RegExp(path));
    }
    await expect(page.getByRole("link", { name: "Team" })).toHaveCount(0);
  });

  test("outside collaborator sees assigned projects but no emails or flags", async ({ page }) => {
    await signIn(page, "architect@demo.test");
    await page.goto("/portfolio");
    await page.getByText("Bergen Street Condominium").click();
    await page.getByRole("tab", { name: "Team" }).click();
    await expect(page.getByText("Elias Ariel")).toBeVisible();
    await expect(page.getByText("elias@demo.test")).toHaveCount(0);
    await expect(page.getByText("Financials", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add person" })).toHaveCount(0);
  });
});

test.describe("owner flows", () => {
  test("invite → accept → new user is signed in", async ({ page, browser }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/team");
    await page.getByRole("button", { name: "Invite someone" }).click();
    const email = `new-${Date.now()}@demo.test`;
    await page.getByLabel("Name").fill("Dana Expediter");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Role").selectOption("external");
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect(page.getByText("Invitation ready")).toBeVisible();
    const url = await page.locator("code").innerText();

    const ctx = await browser.newContext();
    const invitee = await ctx.newPage();
    await invitee.goto(url);
    await expect(invitee.getByRole("heading", { name: "Welcome to Project Command" })).toBeVisible();
    await invitee.getByLabel("Password", { exact: true }).fill("expediter pass 42");
    await invitee.getByLabel("Confirm password").fill("expediter pass 42");
    await invitee.getByRole("button", { name: "Create account" }).click();
    await expect(invitee).toHaveURL(/\/settings\?welcome=1/);
    await expect(invitee.getByText("iPhone install guide")).toBeVisible();

    // The link is single use.
    const again = await ctx.newPage();
    await again.goto(url);
    await expect(again.getByRole("heading", { name: "Already accepted" })).toBeVisible();
    await ctx.close();
  });

  test("create a project and grant access", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByLabel("Project name").fill("Halsey Street Conversion");
    await page.getByLabel("Address").fill("301 Halsey Street");
    await page.getByLabel("Project type").selectOption("condo_conversion");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("heading", { name: "Halsey Street Conversion" })).toBeVisible();

    await page.getByRole("tab", { name: "Team" }).click();
    await page.getByRole("button", { name: "Add person" }).click();
    await page.locator("#pick-user").selectOption({ label: "Ariel Cohen (ariel@demo.test)" });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("switch", { name: "Can approve" }).click();
    await page.getByRole("button", { name: "Add to project" }).click();
    await expect(page.getByText("Ariel Cohen")).toBeVisible();
    await expect(page.getByText("Approver")).toBeVisible();

    await page.goto("/audit");
    await expect(page.getByText("created project Halsey Street Conversion")).toBeVisible();
    await page.getByRole("button", { name: "Verify integrity" }).click();
    await expect(page.getByText(/Chain intact/)).toBeVisible();
  });

  test("System page shows free-tier usage for every service", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/system");
    for (const service of ["Neon Postgres", "Cloudflare R2", "Resend", "GitHub Actions", "Cloudflare Workers"]) {
      await expect(page.getByText(service, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByRole("meter").first()).toBeVisible();
  });
});
