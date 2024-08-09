import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["list"],
    ["blob"],
    [
      "./index.ts",
      {
        url: "https://familiar-alyss-alex-hot-6926ec9c.koyeb.app",
        // url: 'http://localhost:3000',
        resultDetails: {
          key1: "1",
          key2: "2",
        },
        triggerReportGeneration: true,
        dryRun: true,
      },
    ],
  ],
  use: {},
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
