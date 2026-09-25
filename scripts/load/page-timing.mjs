// Brief §13 load check: Portfolio (owner) and My Tasks (a team member) must load in under 1s.
// Usage: BASE=http://localhost:3100 node scripts/load/page-timing.mjs   (against a load-seeded, non-production database)
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:3100";
const RUNS = Number(process.env.RUNS ?? 7);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });

async function session(email) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("demo password 1");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login") && u.pathname !== "/");
  return page;
}

async function time(page, path, ready) {
  const out = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now();
    await page.goto(`${BASE}${path}`, { waitUntil: "commit" });
    await ready(page);
    out.push(Date.now() - t0);
  }
  out.sort((a, b) => a - b);
  return { first: null, median: out[Math.floor(out.length / 2)], max: out[out.length - 1], runs: out };
}

const owner = await session("jon@demo.test");
const portfolio = await time(owner, "/portfolio", async (p) => {
  // Every card is on screen (the data has arrived and rendered), not just the page frame.
  await p.getByRole("heading", { name: "Willoughby Street 124" }).or(p.getByRole("heading", { name: /Street 124/ })).first().waitFor();
});
const member = await session("ariel@demo.test");
const tasks = await time(member, "/tasks", async (p) => {
  await p.getByRole("heading", { name: /Overdue|Today|This week/ }).first().waitFor();
  await p.locator("[data-task-row], li a[href*='task=']").first().waitFor();
});
console.log(JSON.stringify({ portfolio, tasks }, null, 1));
await browser.close();
