import { expect, test } from "@playwright/test";
import zlib from "node:zlib";
import { signIn } from "./helpers";

/** A small real PNG so the photo pipeline (decode → compress → upload → verify) runs end to end. */
function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h, 0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.fill((x * 7 + y * 3) % 255, y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 4 + x * 3);
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let r = 0xffffffff;
    for (const x of b) r = table[(r ^ x) & 0xff]! ^ (r >>> 8);
    return (r ^ 0xffffffff) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test.describe("portfolio", () => {
  test("views, filters and search keep their state in the URL", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/portfolio");
    await expect(page.getByText(/^\d+ projects/)).toBeVisible();
    const bergen = page.getByRole("listitem").filter({ hasText: "Bergen Street Condominium" });
    await expect(bergen.getByText("Construction", { exact: true })).toBeVisible(); // its phase on the card

    await page.getByRole("radio", { name: "Table" }).click();
    await expect(page).toHaveURL(/view=table/);
    await expect(page.getByRole("table")).toContainText("Bergen Street Condominium");

    await page.getByRole("radio", { name: "Timeline" }).click();
    await expect(page.getByRole("region", { name: /Phase timeline/ })).toContainText("Macon Street Auction");

    await page.getByRole("radio", { name: "Map" }).click();
    await expect(page).toHaveURL(/view=map/);

    await page.getByRole("radio", { name: "Cards" }).click();
    await page.getByRole("button", { name: /^Filters/ }).click();
    await page.getByLabel("Status").selectOption("on_hold");
    await expect(page.getByText(/^1 of \d+ projects/)).toBeVisible();
    await expect(page.getByText("Halsey Street Assignment")).toBeVisible();
    await page.reload();
    await expect(page.getByText(/^1 of \d+ projects/)).toBeVisible();
    await page.getByRole("button", { name: "Clear" }).click();

    await page.getByLabel(/Search projects/).fill("300392");
    await page.getByLabel(/Search projects/).press("Enter");
    await expect(page.getByText(/^1 of \d+ projects/)).toBeVisible();
    await expect(page.getByText("Bergen Street Condominium")).toBeVisible();
  });

  test("create a project, move its phase, edit it with a stale-edit check, add a photo, archive and restore", async ({ page, browser }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/portfolio");
    await page.getByRole("button", { name: "New project" }).click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await dialog.getByLabel("Project name").fill("Putnam Avenue Flip");
    await dialog.getByLabel("Address").fill("77 Putnam Avenue");
    await dialog.getByLabel("Project type").selectOption("contract_flip");
    await dialog.getByRole("button", { name: /Key facts/ }).click();
    await dialog.getByLabel("Residential FAR").fill("2.4.1");
    await dialog.getByRole("button", { name: "Next", exact: true }).click();
    await expect(dialog.getByText(/up to two decimals/)).toBeVisible();
    await dialog.getByLabel("Residential FAR").fill("2.43");
    await dialog.getByLabel("Units").fill("4");
    await dialog.getByRole("button", { name: /Headline financials/ }).click();
    await dialog.getByLabel("Purchase price").fill("1,150,000");
    await dialog.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("dialog", { name: "Site conditions" }).getByRole("button", { name: "Create project" }).click();

    await expect(page).toHaveURL(/\/projects\//);
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Putnam Avenue Flip" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Phases" }).getByRole("button", { name: /Marketing to End Buyers/ })).toBeVisible();
    await expect(page.getByText("2.43")).toBeVisible();

    // Advance the phase.
    await page.getByRole("region", { name: "Phases" }).getByRole("button", { name: /Under Contract/ }).click();
    await page.getByRole("button", { name: "Make this the current phase" }).click();
    await expect(page.getByText("Phase updated")).toBeVisible();
    await expect(page.getByText(/In Under Contract/)).toBeVisible();

    // A second tab saves first; this tab's stale save is refused with a clear message.
    const url = page.url();
    const other = await browser.newPage({ storageState: await page.context().storageState() });
    await other.goto(url);
    await other.getByRole("button", { name: "Edit project" }).click();
    await other.getByLabel("Project name").fill("Putnam Avenue Assignment");
    await other.getByRole("button", { name: "Save" }).click();
    await expect(other.getByText("Project saved")).toBeVisible();
    await other.close();
    await page.getByRole("button", { name: "Edit project" }).click();
    await page.getByLabel("Project name").fill("Stale name");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/Someone else changed this project/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Putnam Avenue Assignment" })).toBeVisible();

    // Photo: compressed in the browser, uploaded, becomes the hero.
    await page.locator('input[type="file"]').setInputFiles({ name: "site.png", mimeType: "image/png", buffer: png(640, 480) });
    await expect(page.getByText("Photo added")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Hero", { exact: true })).toBeVisible();
    await expect(page.locator('img[src*="/api/media/photos/"]').first()).toBeVisible();

    // Activity shows the history.
    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.getByText(/added a photo/)).toBeVisible();
    await expect(page.getByText(/moved the project from Pipeline to Under Contract/)).toBeVisible();

    // Archive, find it under archived, restore.
    await page.getByRole("button", { name: "Edit project" }).click();
    await page.getByRole("button", { name: "Archive project" }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page).toHaveURL(/\/portfolio$/);
    await expect(page.getByText("Putnam Avenue Assignment")).toHaveCount(0);
    await page.getByRole("button", { name: "Show archived" }).click();
    await page.getByText("Putnam Avenue Assignment").click();
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("Project restored to the portfolio")).toBeVisible();
  });

  test("editing from a cold page load keeps the project's company", async ({ page }) => {
    await signIn(page, "jon@demo.test");
    await page.goto("/portfolio");
    await page.getByText("Bergen Street Condominium").click();
    await expect(page).toHaveURL(/\/projects\//);
    await page.reload(); // nothing cached
    await page.getByRole("button", { name: "Edit project" }).click();
    await expect(page.getByLabel("Company")).toHaveValue(/.+/);
    await expect(page.getByLabel("Company").locator("option:checked")).toHaveText("Lian Development JV Group");
  });

  test("a member without financial access never sees money", async ({ page }) => {
    await signIn(page, "ariel@demo.test");
    await page.goto("/portfolio");
    await expect(page.getByText("Sterling Place Townhouse")).toBeVisible();
    await expect(page.getByText("Price", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/\$\d/)).toHaveCount(0);
    await page.getByText("Sterling Place Townhouse").click();
    await expect(page.getByRole("tab", { name: "Financials" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit project" })).toHaveCount(0);
    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.getByText(/headline financials/)).toHaveCount(0);
  });
});
