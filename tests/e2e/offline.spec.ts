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
  const ok = await page.evaluate(() =>
    "serviceWorker" in navigator
      ? Promise.race([
          navigator.serviceWorker.ready.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 10_000)),
        ])
      : false,
  );
  if (!ok) return false;
  await page.reload();
  return page.evaluate(() => !!navigator.serviceWorker.controller);
}

const DB_URL = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/pc_e2e_test";

/** A plain open task of Elias's in the Macon project's current phase, just for this test run (no shared demo data). */
async function freshTask(tag: string): Promise<string> {
  const title = `Offline check ${tag} ${Date.now()}`;
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  await db.query(
    `insert into task (project_id, phase_key, title, assignee_id, due_on)
     select p.id, ph.key, $1, u.id, current_date
     from project p join project_phase ph on ph.project_id = p.id and ph.status = 'active', "user" u
     where p.name = 'Macon Street Auction' and u.email = 'elias@demo.test'`,
    [title],
  );
  await db.end();
  return title;
}

/** Wait until this page has been saved for opening offline. */
async function saved(page: Page, url: string) {
  // The page (saved by path) and this person's data (saved a few seconds after it loads).
  const path = new URL(url).origin + new URL(url).pathname;
  await expect
    .poll(
      async () =>
        page.evaluate(
          async (u) => !!(await (await caches.open("pc-pages-v2")).match(u)),
          path,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            new Promise<number>((resolve) => {
              const req = indexedDB.open("pc-offline", 1);
              req.onupgradeneeded = () =>
                req.result.createObjectStore("queries");
              req.onsuccess = () => {
                const tx = req.result.transaction("queries", "readonly");
                const all = tx.objectStore("queries").getAll();
                all.onsuccess = () =>
                  resolve(
                    (
                      all.result as {
                        state?: { queries?: { queryKey: unknown[] }[] };
                      }[]
                    ).reduce(
                      (n, r) =>
                        n +
                        (r.state?.queries ?? []).filter((q) =>
                          JSON.stringify(q.queryKey).includes("checklist"),
                        ).length,
                      0,
                    ),
                  );
                all.onerror = () => resolve(0);
              };
              req.onerror = () => resolve(0);
            }),
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
}

test("iPhone offline: a tick made offline is shown at once, survives a reload, and syncs when back online", async ({ page, context }, testInfo) => {
  const label = await freshTask(testInfo.project.name);
  await signIn(page, "elias@demo.test");
  await page.goto("/portfolio");
  const sw = await swReady(page);
  await page.getByRole("heading", { name: "Macon Street Auction" }).click();
  await page.getByRole("tab", { name: "Checklist" }).click();
  const box = page.getByRole("checkbox", { name: `Complete: ${label}` });
  await expect(box).toBeVisible();
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
  // (Playwright's WebKit can't load a page while emulating offline, even from the service worker; the real iPhone check covers it.)
  if (sw && testInfo.project.name !== "iphone-webkit") {
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

test("iPhone offline: a comment waits on the phone; a tick on a task someone changed meanwhile asks first", async ({ page, context }, testInfo) => {
  const label = await freshTask(testInfo.project.name);
  await signIn(page, "elias@demo.test");
  await page.goto("/portfolio");
  await swReady(page);
  await page.getByRole("heading", { name: "Macon Street Auction" }).click();
  await page.getByRole("tab", { name: "Checklist" }).click();
  const box = page.getByRole("checkbox", { name: `Complete: ${label}` });
  await expect(box).toBeVisible();

  // Open the task and comment while offline.
  await page.getByRole("button", { name: label }).first().click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.locator("#td-comment")).toBeVisible();
  await context.setOffline(true);
  await sheet.locator("#td-comment").fill(`Measured on site, ${label}`);
  await sheet.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(sheet.getByText(`Measured on site, ${label}`)).toBeVisible();
  await expect(sheet.getByText("You · waiting to sync")).toBeVisible();
  await page.keyboard.press("Escape");

  // Tick it offline, while someone else edits the same task.
  await box.click();
  const db = new Client({
    connectionString:
      process.env.E2E_DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/pc_e2e_test",
  });
  await db.connect();
  await db.query(
    "update task set version = version + 1, priority = 'high' where title = $1",
    [label],
  );
  await db.end();

  await context.setOffline(false);
  await expect(
    page.getByRole("status").filter({ hasText: "1 change needs you." }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Review" }).click();
  const review = page.getByRole("dialog", {
    name: "Offline changes that didn't go through",
  });
  await expect(
    review.getByText("Someone changed this task while you were offline."),
  ).toBeVisible();
  await review.getByRole("button", { name: "Tick it anyway" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "needs you" }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByRole("tab", { name: "Checklist" }).click();
  await expect(
    page.getByRole("checkbox", { name: `Reopen: ${label}` }),
  ).toBeVisible();
  // The comment went through too.
  await page.getByRole("button", { name: label }).first().click();
  await expect(
    page.getByRole("dialog").getByText(`Measured on site, ${label}`),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("You · waiting to sync"),
  ).toHaveCount(0);
});

test("iPhone offline: signing out leaves nothing of that person on the phone", async ({
  page,
}) => {
  await signIn(page, "elias@demo.test");
  await page.goto("/portfolio");
  const sw = await swReady(page);
  await page.getByRole("heading", { name: "Macon Street Auction" }).click();
  await page.getByRole("tab", { name: "Checklist" }).click();
  if (sw) await saved(page, page.url());
  const leftovers = () =>
    page.evaluate(async () => {
      const pages = await caches
        .keys()
        .then((ks) =>
          Promise.all(
            ks
              .filter((k) => k.startsWith("pc-pages"))
              .map(async (k) => (await (await caches.open(k)).keys()).length),
          ),
        );
      const data = await new Promise<number>((resolve) => {
        const req = indexedDB.open("pc-offline", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("queries");
        req.onsuccess = () => {
          const c = req.result
            .transaction("queries", "readonly")
            .objectStore("queries")
            .count();
          c.onsuccess = () => resolve(c.result);
          c.onerror = () => resolve(-1);
        };
        req.onerror = () => resolve(-1);
      });
      return {
        pages: pages.reduce((a, b) => a + b, 0),
        data,
        queue: localStorage.getItem("pc.offline.queue.v1"),
      };
    });
  await page.getByRole("link", { name: "Settings" }).last().click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect.poll(leftovers).toEqual({ pages: 0, data: 0, queue: null });
});

test("iPhone offline: opening the app from its icon with no signal shows the person's start page", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name === "iphone-webkit", "Playwright's WebKit can't load pages while emulating offline");
  await signIn(page, "elias@demo.test");
  expect(await swReady(page)).toBe(true);
  // The icon opens "/", which sends an admin on to Portfolio; that page is saved as it's used.
  await page.goto("/");
  await expect(page).toHaveURL(/\/portfolio$/);
  await expect(page.getByRole("heading", { name: "Macon Street Auction" })).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => !!(await (await caches.open("pc-pages-v2")).match(location.origin + "/portfolio"))), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => page.evaluate(async () => (await (await caches.open("pc-meta")).match("/__home"))?.text() ?? null), { timeout: 20_000 }).toBe("/portfolio");

  // …and the portfolio's data is saved on the phone a few seconds after it loads.
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              const r = indexedDB.open("pc-offline", 1);
              r.onupgradeneeded = () => r.result.createObjectStore("queries");
              r.onsuccess = () => {
                const g = r.result.transaction("queries").objectStore("queries").getAll();
                g.onsuccess = () => resolve(JSON.stringify(g.result.map((x: { state: { queries: { queryKey: unknown }[] } }) => x.state.queries.map((q) => q.queryKey))).includes('"projects","list"'));
                g.onerror = () => resolve(false);
              };
              r.onerror = () => resolve(false);
            }),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);

  await context.setOffline(true);
  await page.goto("/");
  await expect(page).toHaveURL(/\/portfolio$/);
  await expect(page.getByRole("heading", { name: "Macon Street Auction" })).toBeVisible();
  await expect(page.getByText("You're offline", { exact: false }).first()).toBeVisible();
  await context.setOffline(false);
});
