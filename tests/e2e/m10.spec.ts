import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

async function openCondo(page: import("@playwright/test").Page) {
  await page.goto("/portfolio");
  await page.getByRole("link").filter({ has: page.getByRole("heading", { name: "Bergen Street Condominium" }) }).click();
  await expect(page).toHaveURL(/\/projects\//);
}

test.describe("directory, units, capital and the investor portal", () => {
  test("new project: a BBL fills the lot's facts from PLUTO", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/portfolio");
    await page.getByRole("button", { name: "New project" }).click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await dialog.getByLabel("Address").fill("100 Demo Street");
    await dialog.getByLabel("BBL").fill("3011370045");
    await dialog.getByLabel("BBL").blur();
    await expect(dialog.getByRole("status")).toContainText("Filled lot area");
    await expect(dialog.getByLabel("Zoning")).toHaveValue("R6B");
    await expect(dialog.getByLabel("Residential FAR")).toHaveValue("2");
    await expect(dialog.getByLabel("Unused ZSF")).toHaveValue("3,000");
    // What someone typed is kept.
    await dialog.getByLabel("Zoning").fill("R7A");
    await dialog.getByRole("button", { name: "Fill facts from PLUTO" }).click();
    await expect(dialog.getByLabel("Zoning")).toHaveValue("R7A");
  });

  test("owner: the directory flags a lapsed COI, holds licenses and people, and invites a contact", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.getByRole("link", { name: "Directory" }).first().click();
    await expect(page.getByRole("heading", { name: "Vendors & contacts" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Stone & Sons/ })).toContainText("COI expired");
    await page.getByRole("link", { name: /Brick & Beam Builders/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Brick & Beam Builders" })).toBeVisible();
    await expect(page.getByText("GC-2041187", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "Bergen Street Condominium" })).toBeVisible();

    await page.getByRole("button", { name: "Add a person" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Name").fill("Pat Lindqvist");
    await d.getByLabel("Title / role").fill("Superintendent");
    await d.getByLabel("Email").fill(`pat-${Date.now()}@brickbeam.example`);
    await d.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Pat Lindqvist")).toBeVisible();
    await page.getByRole("listitem").filter({ hasText: "Pat Lindqvist" }).getByRole("button", { name: "Invite as outside collaborator" }).click();
    await expect(page.getByRole("dialog", { name: "Invite Pat Lindqvist" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("units: selections wait on the buyer, and a sign-off puts the GC's task live", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await openCondo(page);
    await page.getByRole("tab", { name: "Units" }).click();
    await expect(page.getByText("Unit 6C")).toBeVisible();
    await expect(page.getByText("Sign-off overdue")).toBeVisible();
    await page.getByRole("button", { name: /Kitchen: Calacatta quartz/ }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Signed by").fill("Chris Vale");
    await d.getByRole("button", { name: "Record sign-off" }).click();
    await expect(page.getByText("Signed off; the GC's task is live")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Calacatta quartz" }).getByText("Signed off")).toBeVisible();
  });

  test("capital: investors, calls and a distribution split by the waterfall", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await openCondo(page);
    await page.getByRole("tab", { name: "Financials" }).click();
    await page.getByRole("tab", { name: "Capital" }).click();
    await expect(page.getByRole("button", { name: "Harbor Capital LP" })).toBeVisible();
    await expect(page.getByText("8% preferred return to investors")).toBeVisible();
    const call2 = page.getByRole("listitem").filter({ hasText: "Call #2" });
    await call2.getByRole("listitem").filter({ hasText: "Pine Street Partners" }).getByRole("button", { name: "Record receipt" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect(call2.getByText("Fully funded")).toBeVisible();

    await page.getByRole("button", { name: "Record distribution" }).click();
    const d = page.getByRole("dialog", { name: "Record a distribution" });
    await d.getByLabel("Amount").fill("250,000");
    await expect(d.getByText("Sponsor promote")).toBeVisible();
    await d.getByRole("button", { name: "Record" }).click();
    await expect(page.getByText(/Distribution #1 recorded/)).toBeVisible();
    await expect(page.getByRole("link", { name: "PDF" })).toHaveAttribute("href", /investor-report\?quarter=/);
  });

  test("investor: lands on the portal, sees only their account, and can't open the project itself", async ({ page }) => {
    await signIn(page, "investor@demo.test");
    await expect(page).toHaveURL(/\/portal$/);
    await expect(page.getByRole("heading", { name: /Welcome, Rachel/ })).toBeVisible();
    await page.getByRole("link").filter({ has: page.getByRole("heading", { name: "Bergen Street Condominium" }) }).click();
    await expect(page).toHaveURL(/\/portal\//);
    await expect(page.getByRole("heading", { name: "Your capital account" })).toBeVisible();
    await expect(page.getByText("Harbor Capital LP")).toBeVisible();
    await expect(page.getByText("Pine Street Partners")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Download PDF" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Checklist" })).toHaveCount(0);
    const projectId = page.url().split("/portal/")[1]!;
    await page.goto(`/projects/${projectId}`);
    await expect(page).toHaveURL(new RegExp(`/portal/${projectId}$`));
    await page.goto("/portfolio");
    await expect(page).toHaveURL(/\/portal$/);
  });
});
