"use client";

import { Drawer } from "vaul";
import { useOverlay, useOverlayStore } from "@/lib/overlayStore";
import FileManager from "@/components/FileManager";

/**
 * Mobile full-height sheet wrapping `<FileManager/>`.
 *
 * Per `06-integration-plan-mobile.md §2.12` (slot `"filesSheet"` per the plan;
 * we use the AS-SHIPPED short slot `"files"` from `overlayStore.ts`).
 *
 * `visible` is always `true` while the sheet is open — vaul drives mount /
 * unmount via the controlled `open` prop, so the FileManager polling stays
 * alive only when actually displayed.
 *
 * A11y: vaul → Radix Dialog. `aria-label="Файлы"`.
 */

interface MobileFilesSheetProps {
  sessionId: string;
  initialFile?: string | null;
  /** User-initiated close (swipe-down, backdrop tap, ESC). Page-level
   *  использует это чтобы flipnut viewMode → "terminal" — раньше делалось
   *  через inverse-sync useEffect, но он рейсил с forward-sync и
   *  откатывал openOverlay("files") в том же commit. */
  onUserClose?: () => void;
}

export default function MobileFilesSheet({ sessionId, initialFile, onUserClose }: MobileFilesSheetProps) {
  const open = useOverlay("files");
  const openOverlay = useOverlayStore((s) => s.openOverlay);
  const closeOverlay = useOverlayStore((s) => s.closeOverlay);

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(o) => {
        if (o) {
          openOverlay("files");
        } else {
          closeOverlay();
          onUserClose?.();
        }
      }}
      shouldScaleBackground
      dismissible
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/50 z-modal" />
        <Drawer.Content
          aria-label="Файлы"
          className="fixed inset-x-0 bottom-0 z-modal h-[100dvh] bg-surface rounded-t-2xl flex flex-col pb-safe outline-none"
        >
          <div className="mx-auto h-1.5 w-12 my-2 rounded-full bg-border flex-shrink-0" />
          <Drawer.Title className="sr-only">Файлы</Drawer.Title>
          <Drawer.Description className="sr-only">
            Файловый менеджер сессии
          </Drawer.Description>
          <div className="flex-1 min-h-0 overflow-hidden">
            <FileManager sessionId={sessionId} initialFile={initialFile} visible={open} />
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
