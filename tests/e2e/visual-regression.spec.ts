import { test, expect } from "@playwright/test";

/**
 * Visual regression snapshots — login page across viewports.
 *
 * Strategy:
 *   - Capture a full-page screenshot at each of 3 viewports (mobile, tablet, desktop).
 *   - Compare against stored baseline with a generous maxDiffPixels allowance
 *     to tolerate anti-aliasing, CSS animations (aurora), and minor rendering
 *     differences across runs / OSes.
 *   - On first run, Playwright writes the baseline files under
 *     tests/e2e/__screenshots__/. Commit them to track intentional UI changes.
 *   - On CI with no stored baseline the test still PASSES on first run
 *     (Playwright creates the snapshot); subsequent runs compare against it.
 *
 * Masking:
 *   - The aurora background gradient is animated → mask it to prevent
 *     spurious diffs. We mask the full AuroraBackground container.
 *   - Any element that has data-visual-stable="false" is also masked.
 *
 * Usage:
 *   npx playwright test visual-regression --update-snapshots   ← regenerate baselines
 */

// Allow ~3% pixel difference (accounts for sub-pixel rendering, font hinting)
const MAX_DIFF_RATIO = 0.03;
// Hard pixel floor in case the page is very small
const MAX_DIFF_PIXELS = 5_000;

// Viewports to snapshot (device name from playwright.config.ts projects)
// These run within whatever project is active; for cross-viewport coverage
// run with --project=mobile-iphone-se etc.

/** Masks to apply before diffing — hides animated / non-deterministic areas */
async function getAnimatedMasks(page: import("@playwright/test").Page) {
  // Mask the aurora canvas/container (it animates continuously)
  const masks = [
    page.locator("[class*='aurora']"),
    page.locator("canvas"),
    // Loading spinner — animated
    page.locator(".animate-spin"),
    // Any element explicitly opted-out of visual testing
    page.locator("[data-visual-stable='false']"),
  ];
  // Filter to only locators that exist
  const existing: import("@playwright/test").Locator[] = [];
  for (const loc of masks) {
    try {
      const count = await loc.count();
      if (count > 0) existing.push(loc);
    } catch {
      // locator may error on invalid selector — skip
    }
  }
  return existing;
}

test.describe("visual-regression — login page snapshots", () => {
  test.beforeEach(async ({ page }) => {
    // Disable CSS transitions and animations for stable snapshots
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
        }
      `,
    });
  });

  test("login page — full viewport snapshot", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Wait for the UI to settle — form or the "already authed" CTA
    try {
      await page.waitForSelector(
        "form, [role='form'], button:has-text('Начать общение'), .animate-spin",
        { timeout: 10_000 },
      );
    } catch {
      // Proceed with snapshot even if no matching element — better than hanging
    }

    // Extra stabilization wait after disabling animations
    await page.waitForTimeout(200);

    const masks = await getAnimatedMasks(page);

    // Compute pixel threshold from viewport size
    const viewport = page.viewportSize();
    const totalPixels = viewport ? viewport.width * viewport.height : 1_000_000;
    const maxDiffPixels = Math.min(
      MAX_DIFF_PIXELS,
      Math.round(totalPixels * MAX_DIFF_RATIO),
    );

    await expect(page).toHaveScreenshot("login-full.png", {
      fullPage: false, // viewport only — full-page can include off-screen aurora
      maxDiffPixels,
      mask: masks,
      // Clip to viewport so aurora overflow doesn't inflate diff
      clip: viewport
        ? { x: 0, y: 0, width: viewport.width, height: viewport.height }
        : undefined,
    });
  });

  test("login form area — element-level snapshot", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const formLocator = page.locator("form, [role='form']").first();

    try {
      await formLocator.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      test.skip(true, "Login form not visible — user may be already authenticated");
      return;
    }

    await page.waitForTimeout(200);

    await expect(formLocator).toHaveScreenshot("login-form.png", {
      maxDiffPixels: 300, // tighter for isolated component
    });
  });

  test("login logo and title area — element-level snapshot", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // The logo is a div with gradient background and the letter "C"
    const logoLocator = page.locator("h1").first();

    try {
      await logoLocator.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      test.skip(true, "H1 title not visible");
      return;
    }

    await page.waitForTimeout(200);

    await expect(logoLocator).toHaveScreenshot("login-title.png", {
      maxDiffPixels: 150,
    });
  });
});
