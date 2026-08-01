import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.DASHBOARD_PORT ?? "4000";
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Expects an already-running dev server. Use `npm run dev` to start it.
  webServer: {
    command: `npm run dev`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
