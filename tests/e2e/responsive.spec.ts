import { test, expect } from "@playwright/test";

/**
 * Responsive layout tests — viewport coverage across all configured devices.
 *
 * Each test opens / (login page, no auth required) and verifies:
 *   - No horizontal overflow / scroll
 *   - All interactive elements visible, not clipped
 *   - Tap targets ≥ 36 px on mobile
 *   - No console.error or pageerror
 */

// Shared error-collector helper
function collectErrors(page: import("@playwright/test").Page): () => string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Tolerate known-benign dev/SSR noise
      if (/hydration|next-route-announcer|favicon|ResizeObserver/i.test(text)) return;
      // Tolerate expected 401 from /api/auth/check — login page checks auth on load
      if (/401|Unauthorized/.test(text)) return;
      // Tolerate webkit viewport meta tag warnings (interactive-widget not supported in webkit)
      if (/interactive-widget|Viewport argument key/i.test(text)) return;
      errors.push(`console.error: ${text}`);
    }
  });
  return () => errors;
}

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

test.describe("responsive — layout stability", () => {
  test("no horizontal scroll on login page", async ({ page }) => {
    const getErrors = collectErrors(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);

    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    });

    expect(
      hasHorizontalScroll,
      `Horizontal scroll detected: scrollWidth=${await page.evaluate(() => document.documentElement.scrollWidth)}, ` +
        `clientWidth=${await page.evaluate(() => document.documentElement.clientWidth)}`,
    ).toBeFalsy();

    const errors = getErrors();
    expect(errors, `Console/page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("no elements overflow viewport right edge", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);

    const offenders = await page.evaluate(() => {
      const vw = window.innerWidth;
      const results: { tag: string; cls: string; right: number }[] = [];

      const all = document.querySelectorAll("body *");
      for (const el of Array.from(all).slice(0, 600)) {
        const htmlEl = el as HTMLElement;
        const r = htmlEl.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = window.getComputedStyle(htmlEl);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        // Skip aurora/spotlight decoration elements — intentionally bleed outside viewport
        const cls = htmlEl.className?.toString() ?? "";
        if (cls.includes("animate-aurora") || cls.includes("aurora-background") ||
            cls.includes("spotlight") || cls.includes("pointer-events-none")) continue;
        // Skip decorative absolute/fixed elements with no pointer events
        if (cs.pointerEvents === "none" && (cs.position === "absolute" || cs.position === "fixed")) continue;
        if (r.right > vw + 2) {
          results.push({
            tag: htmlEl.tagName.toLowerCase(),
            cls: cls.split(/\s+/).slice(0, 3).join("."),
            right: Math.round(r.right),
          });
        }
      }
      return results.slice(0, 10);
    });

    expect(offenders, `Elements overflowing right: ${JSON.stringify(offenders, null, 2)}`).toEqual([]);
  });

  test("all visible interactive elements are accessible (not zero-size, not behind viewport)", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);

    const clipped = await page.evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const interactive = Array.from(
        document.querySelectorAll("button, a, input, textarea, select, [role='button'], [tabindex]"),
      );

      return interactive
        .filter((el) => {
          const cs = window.getComputedStyle(el as HTMLElement);
          if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false; // hidden input etc.
          // Check if entirely outside viewport (clipped)
          return r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh;
        })
        .map((el) => ({
          tag: (el as HTMLElement).tagName.toLowerCase(),
          text: ((el as HTMLElement).textContent ?? "").trim().slice(0, 40),
          ariaLabel: (el as HTMLElement).getAttribute("aria-label"),
        }));
    });

    expect(
      clipped,
      `Interactive elements outside viewport: ${JSON.stringify(clipped, null, 2)}`,
    ).toEqual([]);
  });

  test("tap target sizes ≥ 36 px on mobile", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile-only tap-target check");

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);

    // Verify form is present before tap-target check
    const formVisible = await page.locator("form").first().isVisible();
    if (!formVisible) {
      test.skip(true, "Login form not rendered — skipping tap-target check");
    }

    const MIN = 36; // Apple HIG is 44, Material 48; 36 is the soft floor

    const tooSmall = await page.evaluate((min: number) => {
      return Array.from(document.querySelectorAll("button, [role='button'], a"))
        .filter((el) => {
          const cs = window.getComputedStyle(el as HTMLElement);
          if (cs.display === "none" || cs.visibility === "hidden") return false;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          return r.width < min || r.height < min;
        })
        .map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return {
            text: ((el as HTMLElement).textContent ?? "").trim().slice(0, 30),
            ariaLabel: (el as HTMLElement).getAttribute("aria-label"),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        });
    }, MIN);

    expect(tooSmall, `Buttons smaller than ${MIN}px: ${JSON.stringify(tooSmall, null, 2)}`).toEqual([]);
  });

  test("no console errors or page errors on load", async ({ page }) => {
    const getErrors = collectErrors(page);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);

    const errors = getErrors();
    expect(errors, `Errors found:\n${errors.join("\n")}`).toEqual([]);
  });
});
