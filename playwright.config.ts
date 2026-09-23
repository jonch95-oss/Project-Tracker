import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/pc_e2e_test";
// In this sandbox Chromium is preinstalled at a fixed path; CI installs browsers normally.
const executablePath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], launchOptions: executablePath ? { executablePath } : {} } },
    // Mobile WebKit (iPhone) runs in CI where WebKit is installed.
    ...(process.env.E2E_WEBKIT === "1" ? [{ name: "iphone-webkit", use: { ...devices["iPhone 15 Pro"] }, testMatch: /mobile\.spec\.ts/ }] : []),
  ],
  webServer: {
    command: process.env.CI ? `npm run start -- -p ${PORT}` : `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      DATABASE_URL,
      APP_URL: `http://localhost:${PORT}`,
      BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123456789",
      JOB_SECRET: "e2e-job-secret-0123456789abcdef",
      E2E_DISABLE_RATE_LIMIT: "1",
      NODE_ENV: process.env.CI ? "production" : "development",
    },
  },
});
