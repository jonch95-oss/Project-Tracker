import { expect, test } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { signIn } from "./helpers";

async function sheetPdf(label: string): Promise<Buffer> {
  const d = await PDFDocument.create();
  const page = d.addPage([792, 612]);
  page.drawText(label, { x: 60, y: 520, size: 36, font: await d.embedFont(StandardFonts.Helvetica) });
  page.drawRectangle({ x: 60, y: 60, width: 672, height: 420, borderWidth: 2 });
  return Buffer.from(await d.save());
}

async function openConstruction(page: import("@playwright/test").Page) {
  await page.goto("/portfolio");
  await page.getByRole("link").filter({ has: page.getByRole("heading", { name: "Bergen Street Condominium" }) }).click();
  await page.getByRole("tab", { name: "Construction" }).click();
}

test.describe("construction", () => {
  test("super files today's log in a few taps", async ({ page }) => {
    await signIn(page, "elias@demo.test");
    await openConstruction(page);
    await expect(page.getByRole("heading", { name: /^Today/ })).toBeVisible();
    await page.getByRole("button", { name: /^Same crew as/ }).click();
    await expect(page.getByText("13 on site").or(page.getByText("12 on site"))).toBeVisible();
    await page.getByLabel("Work performed").fill("Stripped level 7 forms; started 8 deck rebar.");
    await page.getByRole("button", { name: "File today's log" }).click();
    await expect(page.getByText("Log filed")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save log" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download PDF" })).toHaveAttribute("href", /site-logs\?from=/);
  });

  test("owner: schedule against baseline, drawings with a punch pin, meeting action item", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page, "jon@demo.test");
    await openConstruction(page);
    const sections = page.getByRole("tablist", { name: "Construction sections" });

    await sections.getByRole("tab", { name: "Schedule" }).click();
    await expect(page.getByText("Against baseline")).toBeVisible();
    await expect(page.getByText(/days? (behind|ahead)|On baseline/).first()).toBeVisible();

    await sections.getByRole("tab", { name: "RFIs" }).click();
    await page.getByRole("button", { name: /Beam depth at grid C\/4/ }).click();
    await expect(page.getByRole("dialog")).toContainText("Can the W12 at grid C/4 go to W14");
    await page.keyboard.press("Escape");

    await sections.getByRole("tab", { name: "Drawings" }).click();
    await page.getByRole("button", { name: "Issue a set" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Set name").fill("Construction set");
    await d.getByLabel("Sheet PDFs").setInputFiles([
      { name: "A-201 Level 2 plan.pdf", mimeType: "application/pdf", buffer: await sheetPdf("A-201") },
      { name: "A-202 Level 3 plan.pdf", mimeType: "application/pdf", buffer: await sheetPdf("A-202") },
    ]);
    await d.getByRole("button", { name: "Issue set" }).click();
    await expect(page.getByText("Set issued: 2 sheets")).toBeVisible();
    await page.getByRole("button", { name: /^A-201/ }).click();
    const sheet = page.getByRole("img", { name: "Sheet A-201" });
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Drop a punch pin" }).click();
    await sheet.click({ position: { x: 120, y: 90 } });
    const pd = page.getByRole("dialog");
    await pd.getByLabel("What needs fixing").fill("Missing fire caulk at slab edge");
    await pd.getByLabel("Floor").fill("2");
    await pd.getByLabel("Trade").fill("Firestopping");
    await pd.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/Punch #\d+ added/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Punch #\d+: Missing fire caulk/ })).toBeVisible();

    await sections.getByRole("tab", { name: "Punch" }).click();
    await expect(page.getByText("Missing fire caulk at slab edge")).toBeVisible();
    await page.getByLabel("Floor").selectOption("2");
    await expect(page.getByText("Patch slab edge at stair 2")).toHaveCount(0);

    await sections.getByRole("tab", { name: "Meetings" }).click();
    await page.getByRole("button", { name: /OAC #1/ }).click();
    await expect(page.getByRole("link", { name: "Minutes PDF" })).toBeVisible();
    await page.getByRole("button", { name: "Add item" }).click();
    const md = page.getByRole("dialog");
    await md.getByLabel("Item", { exact: true }).fill("Send the updated three-week lookahead");
    const who = md.getByLabel("Who");
    await who.selectOption((await who.locator("option", { hasText: "Elias Ariel" }).getAttribute("value"))!);
    await md.getByLabel("Due").fill("2031-01-15");
    await md.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Action item added and assigned")).toBeVisible();
    await expect(page.getByText("Send the updated three-week lookahead")).toBeVisible();
  });

  test("architect (outside) sees RFIs, submittals, drawings and punch, and answers an RFI", async ({ page }) => {
    await signIn(page, "architect@demo.test");
    await openConstruction(page);
    const sections = page.getByRole("tablist", { name: "Construction sections" });
    await expect(sections.getByRole("tab")).toHaveText(["RFIs", "Submittals", "Drawings", "Punch"]);
    await page.getByRole("button", { name: /Beam depth at grid C\/4/ }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Answer").fill("W14x22 is fine; keep the top of steel.");
    await d.getByRole("button", { name: "Send answer" }).click();
    await expect(page.getByText("Answer sent")).toBeVisible();
  });
});
