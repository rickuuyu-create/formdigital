import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL } from "./e2e/test-runtime";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  // The browser suite intentionally shares one synthetic Local Data Folder
  // and one pair of service processes. Serial execution keeps each scenario's
  // durability and integrity assertions isolated from other writers.
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? E2E_BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
