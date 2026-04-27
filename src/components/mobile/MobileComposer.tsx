"use client";

/**
 * MobileComposer — visible composer panel for mobile terminal input.
 * Replaces the off-screen 1×1 textarea proxy (MobileTerminalInput) with
 * a real input bar: textarea + attach + send + paste-to-clipboard bridge.
 *
 * Layout: fixed at the bottom of the viewport. When the soft keyboard is
 * open, the composer floats just above the ModifierKeyBar (which sits at
 * `bottom: var(--kbd-height)`). When the keyboard is closed, the composer
 * is parked at the safe-area inset; the modifier bar hides itself in that
 * state (see ModifierKeyBar's keyboard guard).
 *
 * Submit semantics:
 *   - Empty draft + no images → no-op.
 *   - Draft only → `term.paste(draft)` (bracketed-paste-aware) followed
 *     by a single `\r`. Modifiers (Ctrl/Alt) from the modifier bar are
 *     consumed and applied to the FIRST byte only via applyArmedModifiers,
 *     matching MobileTerminalInput's contract.
 *   - Images only → base64 array → `{type:"submit", images, text:""}` over WS;
 *     the server's xclip bridge stages them atomically (awaits xclip close event).
 *   - Both → `{type:"submit", text, images}` — server does xclip→Ctrl+V→text→Enter.
 *
 * Paste:
 *   - Image item in clipboard → preview chip in pendingImages strip,
 *     queued for next submit.
 *   - Plain text → falls through into the textarea naturally.
 *
 * Visibility gates:
 *   - `!isMobile` → null (SSR-safe; useIsMobile defaults to false on server)
 *   - `!sessionId` → null (no terminal to send to)
 *   - `activeOverlay !== "none"` → null (sheet/menu is on top, composer hidden)
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type FormEvent,
} from "react";
import { useTerminalIO } from "@/lib/TerminalIOContext";
import { useIsMobile } from "@/lib/useIsMobile";
import { useVisualViewport } from "@/lib/useVisualViewport";
import { useOverlayStore } from "@/lib/overlayStore";
import { useModifierStore } from "@/lib/useModifierState";
import { useComposerStore } from "@/lib/composerStore";
import { applyArmedModifiers, KEYS } from "@/lib/mobile-input";
import { X } from "@/components/Icons";
import ModifierKeyBar from "@/components/mobile/ModifierKeyBar";

interface PendingImage {
  id: string;
  base64: string;
  preview: string; // object URL
  name: string;
}

interface MobileComposerProps {
  sessionId: string | null;
}

const TEXTAREA_MIN_ROWS = 3;  // composer starts at 3 lines (dominant, not tiny)
const TEXTAREA_MAX_ROWS = 8;  // hard cap at 8 lines per R2
const LINE_HEIGHT_PX = 20;    // matches style.lineHeight below
const TEXTAREA_MIN_PX = TEXTAREA_MIN_ROWS * LINE_HEIGHT_PX; // 60px
const TEXTAREA_MAX_PX = TEXTAREA_MAX_ROWS * LINE_HEIGHT_PX; // 160px
// Hard ceiling for paste/attach images. Above this (10 MiB) FileReader
// readAsDataURL produces a >13 MiB base64 string + an in-memory copy in
// React state, which can OOM iOS Safari (real heap limit ~1.4 GiB but
// well below that on low-RAM devices). Server-side xclip pipeline isn't
// useful for huge screenshots either — silently drop with a console hint.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export default function MobileComposer({ sessionId }: MobileComposerProps) {
  const isMobile = useIsMobile();
  const terminalIO = useTerminalIO();
  const { isKeyboardOpen } = useVisualViewport();
  const activeOverlay = useOverlayStore((s) => s.activeOverlay);
  const consumeModifiers = useModifierStore((s) => s.consumeModifiers);
  const setComposerFocused = useComposerStore((s) => s.setFocused);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  // Guards a re-entrant submit (rapid double-tap on Send → two snapshots
  // of the same draft/pending get sent before state clears).
  const submittingRef = useRef(false);
  // Mirror typing: sentValueRef tracks what's actually been streamed to the
  // PTY. On each change we compute a prefix-diff vs this and send only the
  // delta (backspaces + append). On submit we reset to "" because the CLI
  // prompt buffer also clears on Enter.
  const sentValueRef = useRef("");

  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingImage[]>([]);

  // Mirror our textarea ref into TerminalIOContext so the canvas
  // pointerdown handler in Terminal.tsx (line ~496) can summon focus
  // here on tap. Keeps the existing iOS-gesture-focus path working.
  const ioMobileInputRef = terminalIO.mobileInputRef;
  const setTextarea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      taRef.current = el;
      ioMobileInputRef.current = el;
    },
    [ioMobileInputRef],
  );

  // Revoke any preview object URLs on unmount; also clear composer-focused
  // so MobileBottomBar doesn't stay hidden after the composer unmounts.
  useEffect(() => {
    return () => {
      setComposerFocused(false);
      setPending((prev) => {
        for (const p of prev) URL.revokeObjectURL(p.preview);
        return prev;
      });
    };
  }, [setComposerFocused]);

  const hasContent = draft.trim().length > 0 || pending.length > 0;

  /**
   * Mirror typing core: streamDiff(prevValue, newValue) sends a prefix-diff
   * to the PTY in ONE WS message:
   *   1. Find common prefix length P between prev and new.
   *   2. Emit (prev.length - P) backspace bytes ("\x7f").
   *   3. Append new.slice(P).
   *
   * This handles append, backspace, autocorrect-replacement (iOS swaps a
   * mistyped word with the corrected one — diff at non-end) and middle-edit
   * gracefully. The PTY processes byte-by-byte: backspaces erase the prior
   * chars from Claude CLI's prompt buffer, append re-types the corrected
   * tail. The visible composer textarea stays in sync because draft state
   * follows newValue.
   *
   * Returns true if anything was sent (or nothing needed), false if the WS
   * was not OPEN (caller should NOT update sentValueRef so the next change
   * sees the full pending diff).
   */
  const streamDiff = useCallback(
    (prevValue: string, newValue: string): boolean => {
      const ws = terminalIO.wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;

      let prefix = 0;
      const minLen = Math.min(prevValue.length, newValue.length);
      while (prefix < minLen && prevValue[prefix] === newValue[prefix]) prefix++;

      const backspaces = prevValue.length - prefix;
      let append = newValue.slice(prefix);

      if (backspaces === 0 && append.length === 0) {
        return true; // identical, nothing to send
      }

      // Apply armed modifiers (Ctrl/Alt) to the FIRST byte of append only,
      // mirroring desktop behavior. Modifiers don't apply to backspaces.
      if (append.length > 0) {
        const { ctrl, alt } = consumeModifiers();
        if (ctrl || alt) {
          append = applyArmedModifiers(append, ctrl, alt);
        }
      }

      const data = "\x7f".repeat(backspaces) + append;
      try {
        ws.send(JSON.stringify({ type: "input", data }));
      } catch {
        return false;
      }
      return true;
    },
    [consumeModifiers, terminalIO],
  );

  /**
   * Submit handler — fires on Send button, soft "Отправить", or Enter key.
   *
   * Two paths:
   *   - With images → {type:"submit", text:"", images}. The text is already
   *     in the CLI prompt (mirrored via streamDiff); the server only needs
   *     to xclip the images, Ctrl+V them after the existing text, then \r.
   *   - Without images → just send "\r" as a single one-byte input frame.
   *     Identical to the desktop Enter path; CLI sees Enter as a keypress
   *     event and submits the prompt buffer.
   *
   * After send, local draft is cleared (CLI prompt also clears on submit)
   * and sentValueRef resets to "" so the next typed char streams cleanly.
   */
  const submit = useCallback(() => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      const ws = terminalIO.wsRef.current;
      const wsAlive = !!ws && ws.readyState === WebSocket.OPEN;
      if (!wsAlive) {
        requestAnimationFrame(() => { submittingRef.current = false; });
        return;
      }

      // Flush any unsent diff before submit. Important if the user typed
      // very fast and the previous handleChange's WS send was throttled
      // by the browser (e.g., backgrounded tab) — without this flush the
      // PTY's prompt buffer would be missing trailing chars.
      const pendingValue = taRef.current?.value ?? draft;
      if (pendingValue !== sentValueRef.current) {
        if (streamDiff(sentValueRef.current, pendingValue)) {
          sentValueRef.current = pendingValue;
        }
      }

      if (pending.length > 0) {
        // Image flow: server handles xclip + Ctrl+V (after existing mirrored
        // text) + empty text + \r in one atomic queued sequence.
        ws.send(JSON.stringify({
          type: "submit",
          text: "",
          images: pending.map((p) => p.base64),
        }));
        for (const p of pending) URL.revokeObjectURL(p.preview);
        setPending([]);
      } else {
        // No images — Enter alone, identical to desktop path.
        try { ws.send(JSON.stringify({ type: "input", data: "\r" })); } catch {}
      }

      // Reset local state. CLI prompt also clears on submit, so sentValueRef
      // goes back to "" — next char streams from a clean baseline.
      setDraft("");
      sentValueRef.current = "";
      if (taRef.current) {
        taRef.current.value = "";
        taRef.current.style.height = "auto";
      }
      requestAnimationFrame(() => {
        try { taRef.current?.focus({ preventScroll: true }); } catch {}
      });
    } finally {
      requestAnimationFrame(() => { submittingRef.current = false; });
    }
  }, [draft, pending, streamDiff, terminalIO]);

  // `beforeinput` with inputType="insertLineBreak" fires on iOS Safari when
  // the user taps the "Send" key (enterKeyHint="send"). It fires BEFORE the
  // character is inserted into the DOM, so preventDefault() cleanly stops
  // the \n from appearing. We then call submit() — by that time handleChange
  // has already mirrored everything up to and including the last printable
  // character, so submit just emits \r.
  const handleBeforeInput = useCallback(
    (e: FormEvent<HTMLTextAreaElement>) => {
      const nie = e.nativeEvent as InputEvent;
      if (nie.inputType === "insertLineBreak") {
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget;
      let v = ta.value;

      // Fallback for older iOS / Android WebViews that do NOT support
      // beforeinput. If a trailing \n slips through here, treat it as Submit.
      if (!composingRef.current && v.endsWith("\n")) {
        v = v.slice(0, -1);
        ta.value = v;
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, TEXTAREA_MAX_PX) + "px";
        // Mirror the trimmed value first so the PTY catches up to the visible
        // textarea, THEN submit (which only emits \r).
        if (v !== sentValueRef.current) {
          if (streamDiff(sentValueRef.current, v)) sentValueRef.current = v;
        }
        setDraft(v);
        submit();
        return;
      }

      // Mirror diff to PTY UNLESS we're mid-IME composition. iOS predictive
      // text and CJK IME fire intermediate `input` events whose values are
      // NOT what the user intended — wait for compositionend before mirroring.
      if (!composingRef.current) {
        if (streamDiff(sentValueRef.current, v)) sentValueRef.current = v;
      }

      setDraft(v);
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, TEXTAREA_MAX_PX) + "px";
    },
    [streamDiff, submit],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (composingRef.current) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  // fromFileInput=true relaxes the MIME-type check so iOS HEIC files
  // (type="" or "image/heic") pass through instead of being silently dropped.
  const addImageFiles = useCallback((files: File[], fromFileInput = false) => {
    for (const file of files) {
      // iOS Safari may return HEIC files with empty type or "image/heic"/"image/heif".
      // When coming from the file input the user explicitly chose the file, so
      // accept empty-type files too.
      const isImage =
        file.type.startsWith("image/") ||
        (fromFileInput && file.type === "") ||
        file.type === "image/heic" ||
        file.type === "image/heif";
      if (!isImage) {
        console.log(`[composer] skipping file: name=${file.name} type="${file.type}" (not image)`);
        continue;
      }
      // OOM guard — skip oversize images silently. iOS Safari can crash
      // the tab if FileReader builds a 130 MiB+ string; better to drop.
      if (file.size > MAX_IMAGE_BYTES) {
        console.warn(`[composer] image ${file.name} (${file.size}b) exceeds ${MAX_IMAGE_BYTES}b — skipped`);
        continue;
      }
      console.log(`[composer] reading file: name=${file.name} type="${file.type}" size=${file.size}`);
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        console.log(`[composer] FileReader.onload: prefix="${dataUrl.slice(0, 50)}"`);
        const base64Raw = (dataUrl.split(",")[1] ?? "").trim();
        if (!base64Raw) {
          console.warn(`[composer] empty base64 for ${file.name}`);
          return;
        }
        // HEIC: browsers can't decode via <img>. Send raw bytes — server
        // can use ImageMagick if available. User still gets a preview chip
        // (even though the blob: URL won't render for HEIC in Safari).
        const isHeic =
          file.type === "image/heic" ||
          file.type === "image/heif" ||
          (file.type === "" && /\.heic$/i.test(file.name));
        if (isHeic) {
          console.warn(`[composer] HEIC detected for ${file.name} — sending raw (server needs ImageMagick)`);
          const preview = URL.createObjectURL(file);
          const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          setPending((prev) => [...prev, { id, base64: base64Raw, preview, name: file.name }]);
          return;
        }
        // Normalise to PNG via canvas so xclip always gets a valid PNG stream.
        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("no 2d context");
            ctx.drawImage(img, 0, 0);
            const pngDataUrl = canvas.toDataURL("image/png");
            const base64 = (pngDataUrl.split(",")[1] ?? "").trim();
            console.log(`[composer] canvas PNG ready: ${base64.length} chars`);
            const preview = URL.createObjectURL(file);
            const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            setPending((prev) => [...prev, { id, base64, preview, name: file.name }]);
          } catch (canvasErr) {
            console.warn(`[composer] canvas encode failed for ${file.name}, using raw base64:`, canvasErr);
            const preview = URL.createObjectURL(file);
            const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            setPending((prev) => [...prev, { id, base64: base64Raw, preview, name: file.name }]);
          }
        };
        img.onerror = () => {
          console.warn(`[composer] img decode failed for ${file.name}, using raw base64`);
          const preview = URL.createObjectURL(file);
          const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          setPending((prev) => [...prev, { id, base64: base64Raw, preview, name: file.name }]);
        };
        img.src = dataUrl;
      };
      reader.onerror = () => {
        console.error(`[composer] FileReader error for ${file.name}:`, reader.error);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const cd = e.clipboardData;
      if (!cd) return;
      const imageFiles: File[] = [];
      // iOS Safari paste from Photos populates `cd.files`, NOT `cd.items`.
      // Probe both — items first (Chrome / Firefox), then files (iOS).
      for (const item of Array.from(cd.items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length === 0 && cd.files && cd.files.length > 0) {
        for (const file of Array.from(cd.files)) {
          if (file.type.startsWith("image/")) imageFiles.push(file);
        }
      }
      console.log(`[composer] handlePaste: items=${cd.items.length} files=${cd.files?.length ?? 0} imageFiles=${imageFiles.length}`);
      if (imageFiles.length > 0) {
        // Mixed clipboard (image + text from Finder, etc.): preventDefault
        // would normally drop the text. Capture it manually then attach
        // the images to pending — both the image and the text survive.
        e.preventDefault();
        const text = cd.getData("text/plain");
        if (text) {
          const ta = e.currentTarget;
          const start = ta.selectionStart ?? ta.value.length;
          const end = ta.selectionEnd ?? ta.value.length;
          const next = ta.value.slice(0, start) + text + ta.value.slice(end);
          setDraft(next);
          // Mirror the new value to PTY too — without this the pasted text
          // sits in the composer textarea but Claude CLI never receives it
          // until the next typed char triggers handleChange's diff.
          if (streamDiff(sentValueRef.current, next)) sentValueRef.current = next;
          // Restore caret after React commits — best-effort.
          requestAnimationFrame(() => {
            try {
              if (taRef.current) {
                taRef.current.selectionStart = start + text.length;
                taRef.current.selectionEnd = start + text.length;
              }
            } catch {}
          });
        }
        addImageFiles(imageFiles);
      }
      // pure text paste: let the textarea handle it natively, then handleChange
      // will fire with the new value and stream the diff.
    },
    [addImageFiles, streamDiff],
  );

  const removePending = useCallback((id: string) => {
    setPending((prev) => {
      const found = prev.find((p) => p.id === id);
      if (found) URL.revokeObjectURL(found.preview);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const handleFileInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      console.log(`[composer] handleFileInputChange: ${files?.length ?? 0} file(s)`);
      if (files && files.length > 0) {
        // fromFileInput=true: accept empty-type files (iOS HEIC etc.)
        addImageFiles(Array.from(files), true);
      }
      e.target.value = ""; // allow re-selecting the same file
    },
    [addImageFiles],
  );

  if (!isMobile) return null;
  if (!sessionId) return null;
  if (activeOverlay !== "none") return null;

  // Composer is rendered in-flow inside DashboardLayout's column-flex
  // (above MobileBottomBar). No `position: fixed` — that path was fragile
  // on iOS Safari where visualViewport.height vs window.innerHeight
  // diverge in opaque ways across versions, leaving the fixed composer
  // and the in-flow tabbar visually mis-aligned. ModifierKeyBar is now
  // embedded here (no fixed positioning) and shown only when keyboard is open.

  return (
    <div
      role="region"
      aria-label="Композер мобильного терминала"
      className="flex-shrink-0 bg-surface border-t-2 border-accent"
    >
      {/* ModifierKeyBar is ALWAYS visible above the textarea — gives the
          user a stable surface for Esc/Tab/Ctrl/Alt/arrows/Ctrl-C without
          having to wait for the soft keyboard to open. */}
      <ModifierKeyBar visible={true} />

      {pending.length > 0 && (
        <div className="flex gap-2 px-3 pt-2 pb-1 overflow-x-auto">
          {pending.map((p) => (
            <div
              key={p.id}
              className="relative flex-shrink-0 rounded-lg border border-border overflow-hidden"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- blob: URL, no Next/Image */}
              <img
                src={p.preview}
                alt={p.name}
                className="w-14 h-14 object-cover"
              />
              <button
                type="button"
                onClick={() => removePending(p.id)}
                className="absolute top-0.5 right-0.5 w-5 h-5 bg-surface-alt/90 rounded-full flex items-center justify-center text-muted-fg cursor-pointer"
                aria-label={`Убрать ${p.name}`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className="flex items-end gap-1.5 px-2 py-2 pb-safe"
        // Block accidental drops on the composer surface (browser would
        // otherwise navigate away from the page when a file is dropped).
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer?.files?.length) return;
          e.preventDefault();
          addImageFiles(Array.from(e.dataTransfer.files));
        }}
      >
        {/*
          iOS Safari fix: <input type="file"> with display:none cannot be
          triggered by programmatic .click() — the tap is not a trusted gesture.
          Wrapping the input in a <label> makes the tap flow directly through
          the label→input association WITHOUT .click(), which iOS treats as a
          real user gesture. The SVG icon inside the label is pointer-events:none
          so taps on the icon also fall through to the label. The input itself
          is visually hidden via opacity/position, NOT display:none, so it
          remains in the hit-testing tree for the browser's gesture tracking.
        */}
        <label
          className="p-2 text-muted-fg flex-shrink-0 cursor-pointer select-none"
          aria-label="Прикрепить картинку"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileInputChange}
            style={{
              position: "absolute",
              opacity: 0,
              width: 1,
              height: 1,
              overflow: "hidden",
              pointerEvents: "none",
            }}
          />
          <svg
            className="w-5 h-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </label>

        <textarea
          ref={setTextarea}
          value={draft}
          onBeforeInput={handleBeforeInput}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={() => setComposerFocused(true)}
          onBlur={() => setComposerFocused(false)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            // Flush whatever composition produced. handleChange skipped diff
            // sends while composing; compositionend is the right moment to
            // mirror the final composed text to the PTY.
            const v = e.currentTarget.value;
            if (v !== sentValueRef.current) {
              if (streamDiff(sentValueRef.current, v)) sentValueRef.current = v;
            }
          }}
          rows={TEXTAREA_MIN_ROWS}
          inputMode="text"
          enterKeyHint="send"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          aria-label="Команда"
          placeholder="Команда..."
          className="flex-1 bg-transparent text-foreground placeholder-muted outline-none resize-none py-1 px-1"
          style={{
            fontSize: 16, // >=16px — defeats iOS auto-zoom on focus
            lineHeight: `${LINE_HEIGHT_PX}px`,
            minHeight: TEXTAREA_MIN_PX,
            maxHeight: TEXTAREA_MAX_PX,
            overflowY: "auto", // ensure scroll inside textarea on iOS Safari
          }}
        />

        <button
          type="button"
          onClick={submit}
          disabled={!hasContent}
          className="p-2 text-accent-fg flex-shrink-0 disabled:opacity-30 cursor-pointer"
          aria-label="Отправить"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
