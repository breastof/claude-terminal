import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for claude-terminal UI smoke tests.
 *
 * Targets the running PM2 instance on localhost:3000 (blue/active) by default.
 * Override with CT_TEST_PORT env var if blue-green swap has occurred.
 * Tests must NOT touch live tmux sessions or send destructive commands —
 * they assert layout, accessibility, and client-side flows only.
 */
const PORT = process.env.CT_TEST_PORT ?? "3000";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // shared backend, keep deterministic
  retries: 0,
  workers: 1,
  // Global setup signs a synthetic JWT and writes it to setup/auth-state.json.
  // Tests that need an authenticated dashboard session use:
  //   test.use({ storageState: AUTH_STATE_PATH })
  // (imported from ./setup/auth). Tests against the login page (the
  // unauthenticated default) ignore this fixture entirely.
  globalSetup: "./tests/e2e/setup/auth.ts",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "mobile-iphone-se",
      use: { ...devices["iPhone SE"] },
    },
    {
      name: "mobile-pixel-5",
      use: { ...devices["Pixel 5"] },
    },
    {
      name: "tablet-ipad",
      use: { ...devices["iPad (gen 7)"] },
    },
    {
      name: "desktop-1440",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "desktop-1920",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1080 },
      },
    },
  ],
});
