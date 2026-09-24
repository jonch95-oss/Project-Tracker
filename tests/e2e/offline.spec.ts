import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { signIn } from "./helpers";

test.use({ viewport: { width: 393, height: 852 }, serviceWorkers: "allow" });
// Starting the app with no connection needs the production build (the dev server's live reload won't start offline). CI runs against it.
test.skip(!process.env.CI, "Run with CI=1 against a production build");

/**
 * The app's first launch installs the service worker; from the next launch on
 * it saves copies. False where the test browser has no service worker (the
 * queue is still tested there; saved copies are checked on the real iPhone).
 */
async function swReady(page: Page): Promise<boolean> {
  const ok = await page.evaluate(() => ("serviceWorker" in navigator ? Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]) : false));
  if (!ok) return false;
  await page.reload();
  return page.evaluate(() => !!navigator.serviceWorker.controller);
}

/** Wait until this page has been saved for opening offline. */
async function saved(page: Page, url: string) {
  await expect
    .poll(
      async () =>
        page.evaluate(
          async (u) =>
            !!(await (
              await caches.open("pc-pages-v1")
            ).match(u, { ignoreVary: true })),
          url,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
}

test("iPhone offline: a tick made offline is shown at once, survives a reload, and syncs when back online", async ({
  page,
  context,
}) => {
  await signIn(page, "elias@demo.test");
  await page.goto("/portfolio");
  const sw = await swReady(page);
  await page.getByRole("heading", { name: "Sterling Place Townhouse" }).click();
  await page.getByRole("tab", { name: "Checklist" }).click();
  const box = page
    .locator(
      '[role="checkbox"][aria-label^="Complete: "]:not([aria-disabled="true"])',
    )
    .first();
  await expect(box).toBeVisible();
  const label = (await box.getAttribute("aria-label"))!.replace(
    /^Complete: /,
    "",
  );
  const url = page.url();
  if (sw) await saved(page, url);

  await context.setOffline(true);
  await box.click();
  await expect(
    page.getByRole("checkbox", { name: `Reopen: ${label}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "You're offline" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "1 waiting" }),
  ).toBeVisible();

  // Closing and reopening the app offline: the saved copy still shows the tick.
  if (sw) {
    await page.goto(url);
    await page.getByRole("tab", { name: "Checklist" }).click();
    await expect(
      page.getByRole("checkbox", { name: `Reopen: ${label}` }),
    ).toBeVisible();
  }

  await context.setOffline(false);
  await expect(page.getByText(/offline change synced/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByRole("status").filter({ hasText: "waiting" }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByRole("tab", { name: "Checklist" }).click();
  await expect(
    page.getByRole("checkbox", { name: `Reopen: ${label}` }),
  ).toBeVisible();
});

test("iPhone offline: a comment waits on the phone; a tick on a task someone changed meanwhile asks first", async ({ page, context }) => {
  await signIn(page, "elias@demo.test");
  await page.goto("/portfolio");
  await swReady(page);
  await page.getByRole("heading", { name: "Sterling Place Townhouse" }).click();
  await page.getByRole("tab", { name: "Checklist" }).click();
  const box = page.locator('[role="checkbox"][aria-label^="Complete: "]:not([aria-disabled="true"])').first();
  const label = (await box.getAttribute("aria-label"))!.replace(/^Complete: /, "");

  // Open the task and comment while offline.
  await page.getByRole("button", { name: label }).first().click();
  const sheet = page.getByRole("dialog");
  await context.setOffline(true);
  await sheet.locator("#td-comment").fill("Measured on site, offline");
  await sheet.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(sheet.getByText("Measured on site, offline")).toBeVisible();
  await expect(sheet.getByText("You · waiting to sync")).toBeVisible();
  await page.keyboard.press("Escape");

  // Tick it offline, while someone else edits the same task.
  await box.click();
  const db = new Client({ connectionString: process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/pc_e2e_test" });
  await db.connect();
  await db.query("update task set version = version + 1, priority = 'high' where title = $1", [label]);
  await db.end();

  await context.setOffline(false);
  await expect(page.getByRole("status").filter({ hasText: "1 change needs you." })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Review" }).click();
  const review = page.getByRole("dialog", { name: "Offline changes that didn't go through" });
  await expect(review.getByText("Someone changed this task while you were offline.")).toBeVisible();
  await review.getByRole("button", { name: "Tick it anyway" }).click();
  await expect(page.getByRole("status").filter({ hasText: "needs you" })).toHaveCount(0);
  await page.reload();
  await page.getByRole("tab", { name: "Checklist" }).click();
  await expect(page.getByRole("checkbox", { name: `Reopen: ${label}` })).toBeVisible();
  // The comment went through too.
  await page.getByRole("button", { name: label }).first().click();
  await expect(page.getByRole("dialog").getByText("Measured on site, offline")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("You · waiting to sync")).toHaveCount(0);
});
