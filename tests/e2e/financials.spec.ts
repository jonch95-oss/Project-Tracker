import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe("financials", () => {
  test("owner: headline, budget, approve an invoice, build and submit a draw, export to Excel", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/portfolio");
    await page.getByRole("heading", { name: "Bergen Street Condominium" }).click();
    await page.getByRole("tab", { name: "Financials" }).click();
    const panel = page.getByRole("tabpanel", { name: "Summary" });
    await expect(panel.getByText("Total project budget")).toBeVisible();
    await expect(panel.getByText("from the budget")).toBeVisible();
    await expect(panel.getByText("from the unit schedule")).toBeVisible();

    const tabs = page.getByRole("tablist", { name: "Financial sections" });
    await tabs.getByRole("tab", { name: "Budget" }).click();
    await expect(page.getByRole("button", { name: "General contractor" })).toBeVisible();

    await tabs.getByRole("tab", { name: "Invoices" }).click();
    await page.getByRole("button", { name: /Brick & Beam Builders · #Req 5/ }).click();
    const inv = page.getByRole("dialog");
    await inv.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByRole("button", { name: /Req 5/ })).toContainText("Approved");

    await tabs.getByRole("tab", { name: "Draws" }).click();
    await page.getByRole("button", { name: "New draw" }).click();
    const drawBox = page.getByRole("listitem").filter({ hasText: "Draw #1" });
    await drawBox.getByRole("checkbox", { name: /Req 4/ }).check();
    await expect(drawBox.getByText("Brick & Beam Builders").last()).toBeVisible();
    await drawBox.getByRole("checkbox", { name: /Req 5/ }).check();
    await expect(drawBox.getByText("outstanding")).toBeVisible();
    await drawBox.getByRole("button", { name: "Submit to lender" }).click();
    await expect(page.getByText(/lien waiver/)).toBeVisible();
    await drawBox.locator("label").filter({ hasText: "outstanding" }).getByRole("checkbox").check();
    await expect(drawBox.getByText("received")).toBeVisible();
    await drawBox.getByRole("button", { name: "Submit to lender" }).click();
    await expect(drawBox.getByText("Submitted to lender")).toBeVisible();

    const res = await page.request.get(page.url().replace(/\/projects\/([^?]+).*/, "/api/export/projects/$1"));
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("spreadsheetml");
    expect((await res.body()).byteLength).toBeGreaterThan(2000);
  });

  test("an admin with financial access sees the numbers; export is owner-only", async ({ page }) => {
    await signIn(page, "elias@demo.test");
    await page.goto("/portfolio");
    await page.getByRole("heading", { name: "Bergen Street Condominium" }).click();
    await page.getByRole("tab", { name: "Financials" }).click();
    await expect(page.getByText("Projected sellout").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Export to Excel" })).toHaveCount(0);
    const res = await page.request.get(page.url().replace(/\/projects\/([^?]+).*/, "/api/export/projects/$1"));
    expect(res.status()).toBe(404);
  });
});
