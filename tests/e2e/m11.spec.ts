import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe("calendar feed, email-in, analytics and import", () => {
  test("a team member makes a calendar link and the feed serves their dates", async ({ page }) => {
    await signIn(page, "ariel@demo.test");
    await page.goto("/settings");
    const panel = page.getByRole("region", { name: "Calendar feed" }).or(page.locator("section", { hasText: "Calendar feed" }).first());
    await page.getByRole("button", { name: /Make my calendar link|Make a new link/ }).click();
    if (await page.getByRole("dialog").isVisible().catch(() => false)) await page.getByRole("dialog").getByRole("button", { name: "Make a new link" }).click();
    const link = page.getByLabel("Calendar feed link");
    await expect(link).toBeVisible();
    const url = await link.inputValue();
    expect(url).toMatch(/\/api\/calendar\/[A-Za-z0-9_-]+\.ics$/);
    await expect(panel.getByRole("link", { name: "Add to iPhone / Mac Calendar" })).toHaveAttribute("href", /^webcal:/);
    const res = await page.request.get(new URL(url).pathname);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/calendar");
    const ics = await res.text();
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).not.toContain("$");
  });

  test("the investor has no calendar feed in settings", async ({ page }) => {
    await signIn(page, "investor@demo.test");
    await page.goto("/settings");
    await expect(page.getByRole("button", { name: /Make my calendar link/ })).toHaveCount(0);
  });

  test("owner analytics; admins don't see it", async ({ page, browser }) => {
    await signIn(page, "jon@demo.test");
    await page.getByRole("link", { name: "Analytics" }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
    for (const h of ["Days per phase", "Cost per square foot", "Budget variance by category", "Where tasks stall", "Update template durations from actuals"]) await expect(page.getByRole("heading", { name: h })).toBeVisible();

    const ctx = await browser.newContext();
    const admin = await ctx.newPage();
    await signIn(admin, "elias@demo.test");
    await expect(admin.getByRole("link", { name: "Analytics" })).toHaveCount(0);
    await admin.goto("/analytics");
    await expect(admin.getByRole("heading", { level: 1, name: "Analytics" })).toHaveCount(0);
    await ctx.close();
  });

  test("import a vendor list from CSV: counts first, then the rows that were turned away", async ({ page }) => {
    await signIn(page, "elias@demo.test");
    await page.getByRole("link", { name: "Import" }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Import from Excel" })).toBeVisible();
    await page.getByLabel("Kind").selectOption("vendors");
    const stamp = Date.now();
    const csv = `Company,Trade,Phone,Email\nHarbor Glass ${stamp},Glazier,718-555-0101,info@harborglass.test\nNorth Tile ${stamp},Tile,718-555-0102,not-an-email\nHarbor Glass ${stamp},Glazier,,\n`;
    await page.getByLabel("Spreadsheet file").setInputFiles({ name: "vendors.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    const status = page.getByRole("status").filter({ hasText: "Turned away" }).first();
    await expect(status).toContainText(/Read\s*3/);
    await expect(status).toContainText(/Valid\s*1/);
    await expect(status).toContainText(/Turned away\s*2/);
    await expect(page.getByText(/Email "not-an-email" isn't an email address/)).toBeVisible();
    await page.getByRole("button", { name: "Import 1 row" }).click();
    await expect(page.getByRole("heading", { name: "Done" })).toBeVisible();
    await page.goto("/directory");
    await expect(page.getByRole("link", { name: new RegExp(`Harbor Glass ${stamp}`) })).toBeVisible();
  });

  test("a project's Activity says email-in isn't set up yet", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/portfolio");
    await page.getByRole("link").filter({ has: page.getByRole("heading", { name: "Bergen Street Condominium" }) }).click();
    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.getByText("Email into this project")).toBeVisible();
    await expect(page.getByText(/Not set up yet/)).toBeVisible();
  });
});
