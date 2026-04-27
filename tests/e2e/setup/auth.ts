/**
 * Playwright auth fixture for dashboard-gated tests.
 *
 * Reads JWT_SECRET from .env.local at globalSetup time, signs a synthetic
 * test user JWT, and writes it as the `auth-token` cookie into a
 * storageState JSON. Tests that need an authenticated session declare
 * `use: { storageState: AUTH_STATE_PATH }` in their describe block.
 *
 * The synthetic user mirrors a real DB user shape:
 *   { userId: 1, login: "playwright", role: "user", ... }
 *
 * The auth-check route only validates the JWT signature (not DB
 * existence). Routes that hit the DB (sessions/files) may still 404 —
 * those need additional fixtures or a real test user.
 */
import { chromium, type FullConfig } from "@playwright/test";
import jwt from "jsonwebtoken";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Resolve relative to the project root, no ESM-only `import.meta.url`.
// Playwright's ts-node loader handles either CJS or ESM but mixing them via
// __dirname/import.meta cross-context blows up — `process.cwd()` is the
// project root when Playwright runs from there (which it does).
const SETUP_DIR = join(process.cwd(), "tests", "e2e", "setup");
export const AUTH_STATE_PATH = join(SETUP_DIR, "auth-state.json");

function loadJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  // Fallback: parse .env.local manually (Playwright's globalSetup runs
  // before Next loads its own env files).
  const envPath = join(process.cwd(), ".env.local");
  try {
    const content = readFileSync(envPath, "utf-8");
    const match = content.match(/^JWT_SECRET=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    /* ignore */
  }
  throw new Error(
    "JWT_SECRET not found in env or .env.local — auth fixture cannot sign test token",
  );
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  void config;
  const secret = loadJwtSecret();
  const payload = {
    userId: 1,
    login: "playwright",
    firstName: "Play",
    lastName: "Wright",
    role: "user" as const,
    iat: Math.floor(Date.now() / 1000),
  };
  const token = jwt.sign(payload, secret, { expiresIn: "24h" });

  // Pre-bake a Playwright storageState with the auth-token cookie set for
  // localhost (port-agnostic so tests can run against any CT_TEST_PORT).
  const port = process.env.CT_TEST_PORT ?? "3000";
  const storageState = {
    cookies: [
      {
        name: "auth-token",
        value: token,
        domain: "localhost",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // 24h
        httpOnly: true,
        secure: false, // tests run against http://localhost
        sameSite: "Strict" as const,
      },
    ],
    origins: [
      {
        origin: `http://localhost:${port}`,
        localStorage: [],
      },
    ],
  };
  writeFileSync(AUTH_STATE_PATH, JSON.stringify(storageState, null, 2));

  // Sanity check — open a browser, navigate to /, verify we're not redirected
  // to the login form. If we are, the cookie wasn't accepted.
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ storageState: AUTH_STATE_PATH });
    const page = await ctx.newPage();
    const resp = await page.goto(`http://localhost:${port}/api/auth/check`, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    });
    if (!resp || resp.status() !== 200) {
      console.warn(
        `[auth-setup] /api/auth/check returned ${resp?.status() ?? "no response"} — token may not be valid for this server`,
      );
    } else {
      console.log("[auth-setup] auth-token cookie validated against /api/auth/check");
    }
    await ctx.close();
  } catch (err) {
    console.warn(
      `[auth-setup] could not validate cookie (server unreachable?): ${(err as Error).message}`,
    );
  } finally {
    await browser.close();
  }
}
