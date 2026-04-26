"use client";

/**
 * MobileTerminalInput — IME-friendly hidden textarea that proxies typed
 * input into xterm. Per `06-integration-plan-mobile.md §2.5` and
 * `05-decision-mobile.md §2.1` (Recipe `IP-B + IP-D` blend).
 *
 * Design notes:
 *   - Single React-controlled `<textarea rows={1}>` (the `IP-D` substrate)
 *     that follows the `IP-B` outbox philosophy outside composition windows.
 *   - The textarea is positioned absolutely OFF-SCREEN but kept focusable
 *     so iOS Safari opens the soft keyboard. The visible UI is the
 *     ModifierKeyBar above it; users see the round-trip echo inside the
 *     xterm canvas (per `05 §12.11`).
 *   - All bytes are dispatched via `terminalIO.sendInput(...)` which calls
 *     `xtermRef.current.input(data, true)`. This re-uses the existing
 *     `term.onData` listener at `Terminal.tsx:213-221` so the DA/CPR
 *     filter and (future) recording pipeline stay the single ingress
 *     (`05 §6 #13`).
 *   - The mounting parent renders this component only when
 *     `useIsMobile() && useVisualViewport().isKeyboardOpen`. We additionally
 *     gate internally by `useIsMobile()` for SSR safety.
 *
 * Accessibility:
 *   - Russian `aria-label` per `06 §2.5 a11y`.
 *   - Native `<textarea>` is intrinsically focusable and screen-reader
 *     compatible.
 *
 * iOS focus rule: focus must come from a synchronous user gesture per
 * `06 §3.11 step 3` — Terminal.tsx attaches a `pointerdown` listener on
 * the terminal wrapper that calls `mobileInputRef.current?.focus()`
 * synchronously. We only auto-focus on mount as a defensive backup; iOS
 * may ignore it because mount is not a gesture.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
  type ClipboardEvent,
} from "react";
import { useTerminalIO } from "@/lib/TerminalIOContext";
import { useIsMobile } from "@/lib/useIsMobile";
import { useModifierStore } from "@/lib/useModifierState";
import { applyArmedModifiers, KEYS } from "@/lib/mobile-input";

export default function MobileTerminalInput() {
  const isMobile = useIsMobile();
  const terminalIO = useTerminalIO();
  const consumeModifiers = useModifierStore((s) => s.consumeModifiers);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [draft, setDraft] = useState("");

  // Wire taRef into the shared TerminalIOContext so siblings (sheets,
  // ModifierKeyBar) can focus/blur the input via context. We use a
  // callback ref instead of `useEffect`-mutation so the publish/unpublish
  // happens at DOM attach/detach time — cleaner than useEffect timing
  // and silences `react-hooks/immutability` for cross-hook refs.
  const ioMobileInputRef = terminalIO.mobileInputRef;
  const setTextarea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      taRef.current = el;
      ioMobileInputRef.current = el;
    },
    [ioMobileInputRef],
  );

  // Defensive auto-focus on mount. iOS Safari may ignore this because it
  // didn't originate from a synchronous gesture; the gesture path lives
  // in Terminal.tsx pointerdown handler. Android Chrome honors it.
  useEffect(() => {
    if (!isMobile) return;
    taRef.current?.focus({ preventScroll: true });
  }, [isMobile]);

  /**
   * `input` event handler. Per `05 §12.1` pseudocode and `06 §2.5`:
   *   1. If composing → just update draft, don't ship.
   *   2. Else read value, ship via terminalIO.sendInput, clear textarea.
   *   3. Modifiers apply to first character only via applyArmedModifiers.
   */
  const handleInput = useCallback(
    (e: FormEvent<HTMLTextAreaElement>) => {
      const target = e.currentTarget;
      const v = target.value;
      if (composingRef.current) {
        setDraft(v);
        return;
      }
      if (!v) return;
      const { ctrl, alt } = consumeModifiers();
      const bytes = applyArmedModifiers(v, ctrl, alt);
      terminalIO.sendInput(bytes);
      setDraft("");
      target.value = "";
    },
    [consumeModifiers, terminalIO],
  );

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(
    (e: CompositionEvent<HTMLTextAreaElement>) => {
      composingRef.current = false;
      // Samsung-Keyboard / SwiftKey fallback per `06 §2.5`: prefer e.data,
      // fall back to textarea value. Compositions are NOT modifier-wrapped
      // (multi-char input — `05 §12.1` "modifiers apply to first char only"
      // is delegated to `applyArmedModifiers`, not skipped — but for clarity
      // we still call it so a locked Ctrl+(IME composition) stays predictable).
      const final = e.data ?? taRef.current?.value ?? "";
      if (final) {
        const { ctrl, alt } = consumeModifiers();
        const bytes = applyArmedModifiers(final, ctrl, alt);
        terminalIO.sendInput(bytes);
      }
      setDraft("");
      if (taRef.current) taRef.current.value = "";
    },
    [consumeModifiers, terminalIO],
  );

  /**
   * Paste handler per `06 §2.5 handlePaste`:
   *   - Image paste bubbles to Terminal.tsx's existing capture-phase
   *     listener at `Terminal.tsx:336-359` (xclip pipeline). We bail.
   *   - Text paste: prefer `xtermRef.current.paste(text)` so bracketed-paste
   *     mode is honored when the shell enabled `\x1b[?2004h`.
   */
  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const cd = e.clipboardData;
      if (!cd) return;
      if (cd.types.includes("Files")) {
        // Let Terminal.tsx capture-phase paste listener handle the image.
        return;
      }
      const text = cd.getData("text");
      if (!text) return;
      e.preventDefault();
      const term = terminalIO.xtermRef.current;
      if (term) {
        // bracketed-paste-aware. Falls back to raw bytes if the shell
        // didn't enable `\x1b[?2004h`.
        term.paste(text);
      } else {
        terminalIO.sendInput(text);
      }
      setDraft("");
      if (taRef.current) taRef.current.value = "";
    },
    [terminalIO],
  );

  /**
   * Special-key handler per `06 §2.5 handleKeyDown`:
   *   - Enter (no Shift) → `\r` (PTY does cooked-mode \n→\r\n; do NOT
   *     send `\n` per `05 §2.14`).
   *   - Shift+Enter      → allow textarea default (multi-line composition).
   *   - Backspace on empty draft → `\x7f` (DEL byte per xterm convention).
   *   - Tab/Esc/arrows  → not intercepted here; ModifierKeyBar handles them.
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (composingRef.current) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        terminalIO.sendInput(KEYS.Enter);
        setDraft("");
        if (taRef.current) taRef.current.value = "";
        return;
      }
      if (e.key === "Backspace" && draft === "") {
        e.preventDefault();
        terminalIO.sendInput(KEYS.Backspace);
        return;
      }
    },
    [draft, terminalIO],
  );

  if (!isMobile) return null;

  return (
    <div
      role="region"
      aria-label="Мобильный ввод терминала"
      // Positioning: hidden off-screen but focusable per `02-scan-terminal.md
      // §6.2 option 3` (separate React-owned input). The visible UI is the
      // ModifierKeyBar above the keyboard. We use `position: fixed` with
      // tiny size and `opacity: 0` so iOS Safari still considers it visible
      // for focus/keyboard purposes (display:none would prevent focus).
      // z-index: keep below the modifier bar but above the canvas; per
      // `05 §2.9` z-floating (50) is appropriate.
      className="fixed left-0 z-floating"
      style={{
        // Place the textarea just above the keyboard top so iOS scrolls
        // the cursor into view if needed. Visible bar is ModifierKeyBar.
        bottom: "var(--kbd-height, 0px)",
        // Keep the input itself off-screen but reachable for focus.
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: "none",
      }}
    >
      <textarea
        ref={setTextarea}
        // Controlled value: only the IME draft is reflected; outbox bytes
        // are cleared synchronously after every shipment.
        value={draft}
        onChange={() => {
          /* controlled via onInput; React requires an onChange to silence warnings */
        }}
        onInput={handleInput}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        inputMode="text"
        enterKeyHint="send"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        rows={1}
        aria-label="Ввод в терминал"
        // 16px is mandatory (defeats iOS zoom-on-focus per `05 §2.13`);
        // the global mobile CSS rule in `globals.css` is a safety net.
        style={{
          width: 1,
          height: 1,
          fontSize: 16,
          border: 0,
          outline: 0,
          padding: 0,
          margin: 0,
          background: "transparent",
          color: "transparent",
          caretColor: "transparent",
          resize: "none",
          // Re-enable pointer events on the textarea itself so focus can
          // be summoned by `mobileInputRef.current.focus()`.
          pointerEvents: "auto",
        }}
      />
    </div>
  );
}
