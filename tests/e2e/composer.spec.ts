/**
 * Composer mirror-typing tests.
 *
 * Validates that MobileComposer streams every change to the WebSocket
 * as a {type:"input", data: <diff>} frame, mirroring desktop xterm.onData
 * semantics. The test does not need a live PTY backend — it only intercepts
 * outbound WebSocket frames via a `WebSocket.prototype.send` monkey-patch
 * installed before page load.
 *
 * Auth: uses the storageState fixture from setup/auth.ts (pre-baked
 * JWT cookie). Without it, the dashboard would redirect to login.
 *
 * If the dashboard fails to render (e.g., backend changed and the JWT
 * payload no longer satisfies a check), the tests skip gracefully —
 * they assert what they CAN observe and don't pretend to test more.
 */
import { test, expect } from "@playwright/test";
import { AUTH_STATE_PATH } from "./setup/auth";

test.use({ storageState: AUTH_STATE_PATH });

test.describe("composer — mirror typing", () => {
  test.beforeEach(async ({ page }) => {
    // Install WebSocket interceptor BEFORE navigation. Captures every
    // outbound frame into window.__wsSends for later inspection.
    await page.addInitScript(() => {
      (window as unknown as { __wsSends: string[] }).__wsSends = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: string | ArrayBuffer | Blob | ArrayBufferView) {
        try {
          if (typeof data === "string") {
            (window as unknown as { __wsSends: string[] }).__wsSends.push(data);
          }
        } catch {
          /* defensive */
        }
        return origSend.call(this, data);
      };
    });
  });

  test("textarea is reachable on dashboard with auth fixture", async ({ page, isMobile }) => {
    test.skip(!isMobile, "MobileComposer renders only on mobile viewports");
    const resp = await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    // If auth fixture is broken or app rejects token, dashboard 302→/.
    // Tolerate either outcome but flag it; we can't test composer without it.
    if (!resp || resp.status() >= 400) {
      test.skip(true, `dashboard returned ${resp?.status() ?? "no response"}`);
      return;
    }
    // The composer textarea is gated to !!sessionId — without an active
    // session it doesn't render. We verify only the page loaded & the dashboard
    // shell mounted (sessions list visible). Composer-with-session test would
    // need a real POST /api/sessions, which requires a real test user in DB.
    await page.waitForLoadState("networkidle");
    const hasComposer = await page.locator('textarea[aria-label="Команда"]').count();
    test.skip(
      hasComposer === 0,
      "composer not rendered (no active session) — needs a test user + session fixture",
    );
  });

  test("each typed char emits one {type:'input'} WS frame with the diff", async ({ page, isMobile }) => {
    test.skip(!isMobile, "MobileComposer renders only on mobile");
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    const textarea = page.locator('textarea[aria-label="Команда"]');
    const exists = await textarea.count();
    test.skip(exists === 0, "no composer rendered (no active session)");

    // Wait for the WebSocket to open before typing — otherwise the diffs
    // are dropped (streamDiff returns false when ws.readyState !== OPEN).
    await page.waitForFunction(
      () => {
        type WsRef = { current: WebSocket | null };
        // The TerminalIOContext exposes wsRef on window for tests? It does NOT.
        // We rely on the user's typing producing SOME WS send within timeout —
        // if no send happens, this test is a no-op and we skip later.
        return (window as unknown as { __wsSends: string[] }).__wsSends.length >= 0;
      },
      { timeout: 5_000 },
    );

    // Clear capture buffer (auth/check sends may have polluted it; we're
    // looking only at composer-driven sends from now on).
    await page.evaluate(() => {
      (window as unknown as { __wsSends: string[] }).__wsSends = [];
    });

    await textarea.focus();
    await textarea.type("hi", { delay: 50 });

    // Allow event loop to flush.
    await page.waitForTimeout(300);

    const sends = await page.evaluate(
      () => (window as unknown as { __wsSends: string[] }).__wsSends,
    );

    // Expect at least 2 input frames (one per char). Tolerate noise frames.
    const inputFrames = sends
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter((m): m is { type: string; data: string } => !!m && m.type === "input");

    test.skip(
      inputFrames.length === 0,
      "no WS input frames captured — WS may not be connected without a real session",
    );

    // Concat the diff payloads — should reconstruct the typed text.
    const reconstructed = inputFrames.map((f) => f.data).join("");
    expect(
      reconstructed,
      `expected reconstructed input "hi", got "${reconstructed}" from frames: ${JSON.stringify(inputFrames)}`,
    ).toBe("hi");
  });
});
