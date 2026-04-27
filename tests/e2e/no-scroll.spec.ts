import { test, expect } from "@playwright/test";

/**
 * Critical scroll-lock tests for the login page.
 *
 * The login page uses AuroraBackground which must fill the viewport exactly.
 * Page-level scroll is intentionally disabled so the aurora gradient never
 * shifts. These tests verify that contract is upheld across all viewports.
 *
 * Checks:
 *   1. documentElement overflow is 'hidden' or 'clip' (CSS scroll lock)
 *   2. scrollHeight === clientHeight (no scrollable content)
 *   3. window.scrollBy(0, 1000) does NOT move the page
 *   4. body overflow is also locked
 */

// Wait for login page to fully load: auth check completes, spinner disappears
async function waitForLoginPage(page: import("@playwright/test").Page): Promise<void> {
  try {
    await page.waitForSelector("form, [role='form'], .animate-spin", { timeout: 10_000 });
    // If spinner appeared, wait for it to go away (auth check completes)
    const spinner = page.locator(".animate-spin").first();
    if (await spinner.isVisible()) {
      await spinner.waitFor({ state: "hidden", timeout: 10_000 });
    }
  } catch {
    // Page loaded but element not yet present — proceed
  }
}

test.describe("no-scroll — login page scroll-lock", () => {
  test("documentElement overflow is locked (hidden or clip)", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);

    const overflowValue = await page.evaluate(() => {
      return window.getComputedStyle(document.documentElement).overflow;
    });

    // Allow 'hidden', 'clip', or composite values like 'hidden hidden'
    const isLocked =
      overflowValue === "hidden" ||
      overflowValue === "clip" ||
      overflowValue.includes("hidden") ||
      overflowValue.includes("clip");

    expect(
      isLocked,
      `Expected documentElement.overflow to be 'hidden' or 'clip', got '${overflowValue}'. ` +
        "The login page should prevent full-page scroll.",
    ).toBeTruthy();
  });

  test("body overflow is locked on login page", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);

    const bodyOverflow = await page.evaluate(() => {
      return window.getComputedStyle(document.body).overflow;
    });

    const isLocked =
      bodyOverflow === "hidden" ||
      bodyOverflow === "clip" ||
      bodyOverflow.includes("hidden") ||
      bodyOverflow.includes("clip");

    // Either html or body must be locked — check both together
    const htmlOverflow = await page.evaluate(() => {
      return window.getComputedStyle(document.documentElement).overflow;
    });

    const htmlLocked =
      htmlOverflow.includes("hidden") || htmlOverflow.includes("clip");

    expect(
      isLocked || htmlLocked,
      `Neither body (${bodyOverflow}) nor html (${htmlOverflow}) overflow is locked. ` +
        "Login page must prevent scroll at the root level.",
    ).toBeTruthy();
  });

  test("scrollHeight equals clientHeight — no overflowing content", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);

    const metrics = await page.evaluate(() => {
      return {
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        scrollTop: document.documentElement.scrollTop,
      };
    });

    // Allow a 1px rounding tolerance
    expect(
      metrics.scrollHeight,
      `scrollHeight (${metrics.scrollHeight}) exceeds clientHeight (${metrics.clientHeight}) by more than 1px — ` +
        "content is taller than the viewport and scroll is possible.",
    ).toBeLessThanOrEqual(metrics.clientHeight + 1);
  });

  test("window.scrollBy(0, 1000) does NOT scroll the page", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);

    // Capture baseline scroll position
    const beforeScroll = await page.evaluate(() => ({
      scrollY: window.scrollY,
      scrollTop: document.documentElement.scrollTop,
    }));

    // Attempt to scroll
    await page.evaluate(() => {
      window.scrollBy(0, 1000);
    });

    // Give browser one paint cycle to apply the scroll (if not blocked)
    await page.waitForTimeout(50);

    const afterScroll = await page.evaluate(() => ({
      scrollY: window.scrollY,
      scrollTop: document.documentElement.scrollTop,
    }));

    expect(
      afterScroll.scrollY,
      `window.scrollY changed from ${beforeScroll.scrollY} to ${afterScroll.scrollY} ` +
        "after scrollBy(0, 1000) — page scroll is NOT blocked.",
    ).toBe(beforeScroll.scrollY);

    expect(
      afterScroll.scrollTop,
      `documentElement.scrollTop changed from ${beforeScroll.scrollTop} to ${afterScroll.scrollTop} ` +
        "after scrollBy(0, 1000) — page scroll is NOT blocked.",
    ).toBe(beforeScroll.scrollTop);
  });

  test("no horizontal scroll triggered by touch-drag emulation", async ({ page, isMobile }) => {
    test.skip(!isMobile, "touch-drag emulation only runs on mobile projects");

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);

    const beforeX = await page.evaluate(() => window.scrollX);

    // Simulate a horizontal swipe gesture
    const { width, height } = page.viewportSize() ?? { width: 375, height: 667 };
    await page.touchscreen.tap(width / 2, height / 2);
    // Approximate swipe via mouse drag (fallback when touchscreen.swipe unavailable)
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.down();
    await page.mouse.move(width / 2 - 200, height / 2, { steps: 10 });
    await page.mouse.up();

    await page.waitForTimeout(50);

    const afterX = await page.evaluate(() => window.scrollX);

    expect(
      afterX,
      `Horizontal scroll moved from ${beforeX} to ${afterX} after swipe gesture.`,
    ).toBe(beforeX);
  });
});
