import { test, expect } from "@playwright/test";

test.describe("login page — responsive smoke", () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        const text = msg.text();
        // Tolerate dev hydration warnings from third-party libs
        if (/hydration|next-route-announcer|favicon/i.test(text)) return;
        // Tolerate expected 401 from /api/auth/check — login page checks auth on load
        if (/401|Unauthorized/.test(text)) return;
        // Tolerate webkit viewport meta tag warnings (interactive-widget not supported)
        if (/interactive-widget|Viewport argument key/i.test(text)) return;
        // Only capture actual errors, not warnings
        if (msg.type() !== "error") return;
        errors.push(`console: ${text}`);
      }
    });
    (page as unknown as { __errors: string[] }).__errors = errors;
  });

  test("renders without console errors", async ({ page }) => {
    const resp = await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(resp?.ok()).toBeTruthy();

    // Wait for auth check to complete: spinner disappears, form appears
    await expect(page.locator(".animate-spin").first()).not.toBeVisible({ timeout: 10_000 }).catch(() => {});
    // Wait for the form to appear
    await expect(page.locator("form, [role='form']").first()).toBeVisible({ timeout: 10_000 });

    // Tabs (Вход / Регистрация / Гость)
    await expect(page.getByRole("button", { name: /вход/i }).first()).toBeVisible();

    // No horizontal scrollbar — overflow check
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    });
    expect(hasHorizontalScroll).toBeFalsy();

    // No collected page/console errors
    const errors = (page as unknown as { __errors: string[] }).__errors;
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("primary CTAs have minimum tap-target size on mobile", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile-only check");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("form").first()).toBeVisible();

    const tooSmall = await page.evaluate(() => {
      const MIN = 36; // Apple HIG = 44, Material = 48; 36 is a soft floor
      const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
      return buttons
        .filter((b) => {
          const rect = b.getBoundingClientRect();
          // Skip invisible
          if (rect.width === 0 || rect.height === 0) return false;
          // Skip hidden
          const cs = window.getComputedStyle(b);
          if (cs.visibility === "hidden" || cs.display === "none") return false;
          return rect.width < MIN || rect.height < MIN;
        })
        .map((b) => {
          const rect = b.getBoundingClientRect();
          return {
            text: (b.textContent ?? "").trim().slice(0, 30),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        });
    });
    expect(tooSmall, JSON.stringify(tooSmall, null, 2)).toEqual([]);
  });

  test("layout stays inside viewport (no clipping)", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Wait for auth check to complete before checking layout
    await expect(page.locator(".animate-spin").first()).not.toBeVisible({ timeout: 10_000 }).catch(() => {});
    await expect(page.locator("form").first()).toBeVisible({ timeout: 10_000 });

    const overflow = await page.evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const offenders: { selector: string; right: number; bottom: number }[] = [];
      const els = document.querySelectorAll("body *");
      for (const el of Array.from(els).slice(0, 500)) {
        const htmlEl = el as HTMLElement;
        const r = htmlEl.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // Skip aurora decoration elements — they intentionally bleed outside viewport
        const cls = htmlEl.className?.toString() ?? "";
        if (cls.includes("animate-aurora") || cls.includes("aurora-background")) continue;
        // Skip elements with position:fixed or absolute that are decorative (pointer-events-none)
        const cs = window.getComputedStyle(htmlEl);
        if (cs.pointerEvents === "none" && (cs.position === "absolute" || cs.position === "fixed")) continue;
        if (r.right > vw + 1 || r.bottom > vh + 100) {
          offenders.push({
            selector: htmlEl.tagName.toLowerCase() + (cls ? "." + cls.split(/\s+/).slice(0, 2).join(".") : ""),
            right: Math.round(r.right),
            bottom: Math.round(r.bottom),
          });
        }
      }
      return offenders.slice(0, 5);
    });
    expect(overflow, JSON.stringify(overflow, null, 2)).toEqual([]);
  });
});
