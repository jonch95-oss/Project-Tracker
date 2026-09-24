import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

test.use({ viewport: { width: 393, height: 852 }, serviceWorkers: "allow" });
// Starting the app with no connection needs the production build (the dev server's live reload won't start offline). CI runs against it.
test.skip(!process.env.CI, "Run with CI=1 against a production build");

/** The app's first launch installs the service worker; from the next launch on it saves copies. */
async function swReady(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(
    true,
  );
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
  await swReady(page);
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
  await saved(page, url);

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
  await page.goto(url);
  await page.getByRole("tab", { name: "Checklist" }).click();
  await expect(
    page.getByRole("checkbox", { name: `Reopen: ${label}` }),
  ).toBeVisible();

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
