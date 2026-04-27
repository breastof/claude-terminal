import { test, expect } from "@playwright/test";

/**
 * DOM stability tests — detect resize-loops, layout thrashing, and
 * infinite re-render patterns that cause performance degradation.
 *
 * Strategy:
 *   1. Inject a MutationObserver + ResizeObserver before page load,
 *      wait 2 s after page settles, then read counters.
 *   2. Cap mutations at a reasonable ceiling (layout loop would spike far above).
 *   3. Use performance.getEntriesByType("longtask") to flag layout thrashing
 *      (long tasks > 50 ms are a strong signal of thrash).
 *
 * These tests run in desktop project by default (no auth needed, login page only).
 */

const MUTATION_CEILING = 200; // auth check + spinner transition + aurora adds more mutations
const RESIZE_CEILING = 50;   // login page has no dynamic resizing
const LONG_TASK_CEILING = 5; // > 5 long tasks in 2 s is a red flag

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

test.describe("dom-stability — resize-loop and layout-thrash detection", () => {
  test("MutationObserver — mutation count stays under ceiling after load", async ({ page }) => {
    // Inject counter script before navigation
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__mutationCount = 0;
      (window as unknown as Record<string, unknown>).__mutationObserver = new MutationObserver((records) => {
        (window as unknown as Record<string, number>).__mutationCount += records.length;
      });
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);

    // Start observing after DOM is ready and login form is rendered
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      (w.__mutationObserver as MutationObserver).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: false,
      });
      w.__mutationCount = 0; // reset — only count post-load mutations
    });

    // Wait for the aurora animation and any React re-renders to settle
    await page.waitForTimeout(2_000);

    const count = await page.evaluate(
      () => (window as unknown as Record<string, number>).__mutationCount,
    );

    // Disconnect observer
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      (w.__mutationObserver as MutationObserver).disconnect();
    });

    expect(
      count,
      `${count} DOM mutations observed in 2 s after load — exceeds ceiling of ${MUTATION_CEILING}. ` +
        "This may indicate a render loop (e.g. repeated state updates triggering infinite re-renders).",
    ).toBeLessThanOrEqual(MUTATION_CEILING);
  });

  test("ResizeObserver — element resize count stays under ceiling after load", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__resizeCount = 0;
      (window as unknown as Record<string, unknown>).__resizeObserver = new ResizeObserver(() => {
        (window as unknown as Record<string, number>).__resizeCount++;
      });
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);

    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      // Observe all existing elements (up to 50 to avoid perf overhead)
      Array.from(document.querySelectorAll("div, section, main, header, form")).slice(0, 50).forEach((el) => {
        (w.__resizeObserver as ResizeObserver).observe(el);
      });
      w.__resizeCount = 0; // reset counter after initial observation burst
    });

    await page.waitForTimeout(2_000);

    const count = await page.evaluate(
      () => (window as unknown as Record<string, number>).__resizeCount,
    );

    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      (w.__resizeObserver as ResizeObserver).disconnect();
    });

    expect(
      count,
      `${count} resize events in 2 s after load — exceeds ceiling of ${RESIZE_CEILING}. ` +
        "This suggests a resize loop: an element's size depends on itself (circular dependency).",
    ).toBeLessThanOrEqual(RESIZE_CEILING);
  });

  test("PerformanceObserver — no excessive long tasks (layout thrashing)", async ({ page }) => {
    // Long Task API is only available in Chromium-based browsers
    const browserName = (page.context().browser()?.browserType().name() ?? "").toLowerCase();
    test.skip(
      browserName === "webkit" || browserName === "firefox",
      "Long Task API only available in Chromium",
    );

    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__longTaskCount = 0;
      try {
        const observer = new PerformanceObserver((list) => {
          (window as unknown as Record<string, number>).__longTaskCount += list.getEntries().length;
        });
        observer.observe({ entryTypes: ["longtask"] });
        (window as unknown as Record<string, unknown>).__longTaskObserver = observer;
      } catch {
        // PerformanceObserver with longtask not supported — mark as N/A
        (window as unknown as Record<string, unknown>).__longTaskSupported = false;
      }
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);
    await page.waitForTimeout(2_000);

    const result = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      if (w.__longTaskSupported === false) return { supported: false, count: 0 };
      try {
        (w.__longTaskObserver as PerformanceObserver).disconnect();
      } catch {
        // ignore
      }
      return { supported: true, count: (w.__longTaskCount as number) ?? 0 };
    });

    if (!result.supported) {
      test.skip(true, "Long Task API not supported in this browser");
      return;
    }

    expect(
      result.count,
      `${result.count} long tasks (>50 ms) detected in 2 s — exceeds ceiling of ${LONG_TASK_CEILING}. ` +
        "Long tasks block the main thread and are a strong indicator of layout thrashing or heavy re-renders.",
    ).toBeLessThanOrEqual(LONG_TASK_CEILING);
  });

  test("no infinite requestAnimationFrame loop (rAF fires < 300 times in 2 s)", async ({ page }) => {
    // A capped animation should fire ~120 times in 2 s at 60 fps.
    // An uncapped rAF loop would fire far more (approaching 1000+).
    const RAF_CEILING = 300;

    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__rafCount = 0;
      const origRAF = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb: FrameRequestCallback) => {
        (window as unknown as Record<string, number>).__rafCount++;
        return origRAF(cb);
      };
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);
    await page.waitForTimeout(2_000);

    const rafCount = await page.evaluate(
      () => (window as unknown as Record<string, number>).__rafCount,
    );

    // Aurora animation legitimately uses rAF — use a generous ceiling
    expect(
      rafCount,
      `requestAnimationFrame called ${rafCount} times in 2 s — exceeds ceiling of ${RAF_CEILING}. ` +
        "A runaway rAF loop can cause 100% CPU usage and visual jank.",
    ).toBeLessThanOrEqual(RAF_CEILING);
  });

  test("page load time is under 15 s (navigation timing including auth check)", async ({ page }) => {
    const start = Date.now();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLoginPage(page);

    const elapsed = Date.now() - start;

    // 15 s threshold: includes domcontentloaded + auth check fetch + React render
    expect(
      elapsed,
      `Page took ${elapsed} ms to reach domcontentloaded + first render. Threshold: 15 000 ms.`,
    ).toBeLessThan(15_000);
  });
});
