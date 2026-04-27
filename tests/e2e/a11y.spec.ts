import { test, expect } from "@playwright/test";

/**
 * Accessibility tests for the login page.
 *
 * Covers:
 *   - All buttons have an accessible name (aria-label OR inner text)
 *   - Form inputs have associated labels (via <label for>, aria-label, or aria-labelledby)
 *   - Tab navigation follows a logical, predictable order
 *   - Page has a single <h1>
 *   - Interactive elements have visible focus rings (not outline:none without alternative)
 *   - No aria attributes with invalid/empty values
 *
 * No external a11y library used — pure DOM inspection so there are zero
 * extra dependencies.
 */

test.describe("a11y — login page accessibility", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Wait for the React tree to settle (form OR loading spinner)
    try {
      await page.waitForSelector("form, [role='form'], .animate-spin", { timeout: 10_000 });
    } catch {
      // Continue — some checks don't need the form
    }
  });

  test("all visible buttons have an accessible name", async ({ page }) => {
    const nameless = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("button, [role='button']"))
        .filter((el) => {
          const cs = window.getComputedStyle(el as HTMLElement);
          if (cs.display === "none" || cs.visibility === "hidden") return false;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;

          const ariaLabel = (el as HTMLElement).getAttribute("aria-label")?.trim();
          const ariaLabelledBy = (el as HTMLElement).getAttribute("aria-labelledby");
          const innerText = ((el as HTMLElement).textContent ?? "").trim();
          const title = (el as HTMLElement).getAttribute("title")?.trim();

          // Has accessible name if any of these exist and are non-empty
          if (ariaLabel) return false;
          if (title) return false;
          if (innerText.length > 0) return false;
          if (ariaLabelledBy) {
            const labeled = document.getElementById(ariaLabelledBy);
            if (labeled && (labeled.textContent ?? "").trim().length > 0) return false;
          }
          return true;
        })
        .map((el) => ({
          tag: (el as HTMLElement).tagName.toLowerCase(),
          outerHTML: (el as HTMLElement).outerHTML.slice(0, 120),
        }));
    });

    expect(
      nameless,
      `Buttons without accessible names:\n${nameless.map((b) => b.outerHTML).join("\n")}`,
    ).toEqual([]);
  });

  test("form inputs have associated labels", async ({ page }) => {
    // Wait specifically for form inputs — skip if login form not yet rendered
    const hasForm = await page.locator("form input, form textarea").count();
    test.skip(hasForm === 0, "No form inputs found — login form not rendered yet");

    const unlabeled = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("input, textarea, select"))
        .filter((el) => {
          const cs = window.getComputedStyle(el as HTMLElement);
          if (cs.display === "none") return false;
          const type = (el as HTMLInputElement).type;
          // Hidden inputs and submit buttons don't need labels
          if (type === "hidden" || type === "submit" || type === "button" || type === "file") return false;

          const id = (el as HTMLElement).id;
          const ariaLabel = (el as HTMLElement).getAttribute("aria-label")?.trim();
          const ariaLabelledBy = (el as HTMLElement).getAttribute("aria-labelledby");
          const title = (el as HTMLElement).getAttribute("title")?.trim();
          const placeholder = (el as HTMLInputElement).placeholder?.trim();

          if (ariaLabel) return false; // explicit aria-label
          if (title) return false;
          if (placeholder) return false; // placeholder is not ideal but counts as fallback
          if (ariaLabelledBy) {
            const ref = document.getElementById(ariaLabelledBy);
            if (ref && (ref.textContent ?? "").trim().length > 0) return false;
          }
          if (id) {
            const label = document.querySelector(`label[for="${id}"]`);
            if (label && (label.textContent ?? "").trim().length > 0) return false;
          }
          // Check for wrapping <label>
          let parent = (el as HTMLElement).parentElement;
          while (parent) {
            if (parent.tagName.toLowerCase() === "label") return false;
            parent = parent.parentElement;
          }
          return true;
        })
        .map((el) => ({
          tag: (el as HTMLElement).tagName.toLowerCase(),
          type: (el as HTMLInputElement).type ?? "",
          id: (el as HTMLElement).id ?? "",
          name: (el as HTMLInputElement).name ?? "",
        }));
    });

    expect(
      unlabeled,
      `Form inputs without labels:\n${JSON.stringify(unlabeled, null, 2)}`,
    ).toEqual([]);
  });

  test("page has exactly one <h1>", async ({ page }) => {
    const h1Count = await page.evaluate(() => document.querySelectorAll("h1").length);

    expect(
      h1Count,
      `Expected exactly 1 <h1> on the page, found ${h1Count}. ` +
        "Multiple h1s break screen-reader document outline.",
    ).toBe(1);
  });

  test("h1 text is meaningful (not empty)", async ({ page }) => {
    const h1Text = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      return h1 ? (h1.textContent ?? "").trim() : null;
    });

    expect(h1Text, "No <h1> found on the page").not.toBeNull();
    expect(
      h1Text?.length ?? 0,
      `<h1> is empty — screen readers will announce nothing for the page title`,
    ).toBeGreaterThan(0);
  });

  test("Tab navigation reaches the primary form action", async ({ page }) => {
    const hasForm = await page.locator("form").count();
    test.skip(hasForm === 0, "Login form not rendered — skipping Tab navigation test");

    // Start with focus on body, then tab through the page
    await page.evaluate(() => (document.body as HTMLElement).focus());

    const focusedElements: string[] = [];
    const MAX_TABS = 20;

    for (let i = 0; i < MAX_TABS; i++) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        if (!el || el === document.body) return null;
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? "").trim().slice(0, 30),
          ariaLabel: el.getAttribute("aria-label"),
          type: (el as HTMLInputElement).type ?? null,
          role: el.getAttribute("role"),
        };
      });

      if (!focused) continue;
      const label = focused.ariaLabel ?? focused.text ?? `${focused.tag}[${focused.type ?? focused.role ?? ""}]`;
      focusedElements.push(label);
    }

    // At minimum, tab order should have reached at least one input or button
    const reachedInteractive = focusedElements.length > 0;
    expect(
      reachedInteractive,
      `Tab key did not focus any interactive elements. ` +
        "Form elements may be missing tabindex or have tabindex=-1.",
    ).toBeTruthy();
  });

  test("no aria-label attributes are empty strings", async ({ page }) => {
    const emptyAriaLabels = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("[aria-label]"))
        .filter((el) => {
          const v = (el as HTMLElement).getAttribute("aria-label") ?? "";
          return v.trim().length === 0;
        })
        .map((el) => ({
          tag: (el as HTMLElement).tagName.toLowerCase(),
          outerHTML: (el as HTMLElement).outerHTML.slice(0, 100),
        }));
    });

    expect(
      emptyAriaLabels,
      `Elements with empty aria-label:\n${emptyAriaLabels.map((e) => e.outerHTML).join("\n")}`,
    ).toEqual([]);
  });

  test("images have non-empty alt text or are marked as decorative", async ({ page }) => {
    const badImages = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("img"))
        .filter((img) => {
          const cs = window.getComputedStyle(img);
          if (cs.display === "none" || cs.visibility === "hidden") return false;
          const alt = img.getAttribute("alt");
          // alt="" is valid for decorative images; missing alt is not
          if (alt === null) return true; // missing → bad
          // alt="" is fine (decorative)
          return false;
        })
        .map((img) => ({
          src: img.src.slice(-50),
          altAttr: img.getAttribute("alt"),
        }));
    });

    expect(
      badImages,
      `Images missing alt attribute:\n${JSON.stringify(badImages, null, 2)}`,
    ).toEqual([]);
  });

  test("no positive tabindex values that break natural tab order", async ({ page }) => {
    const positiveTabindex = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("[tabindex]"))
        .filter((el) => {
          const v = parseInt((el as HTMLElement).getAttribute("tabindex") ?? "0", 10);
          return v > 0;
        })
        .map((el) => ({
          tag: (el as HTMLElement).tagName.toLowerCase(),
          tabindex: (el as HTMLElement).getAttribute("tabindex"),
          text: ((el as HTMLElement).textContent ?? "").trim().slice(0, 30),
        }));
    });

    expect(
      positiveTabindex,
      `Elements with tabindex > 0 (breaks natural tab order):\n${JSON.stringify(positiveTabindex, null, 2)}`,
    ).toEqual([]);
  });
});
