"use client";

import { Drawer } from "vaul";
import { useOverlay, useOverlayStore } from "@/lib/overlayStore";
import ChatPanel from "@/components/chat/ChatPanel";

/**
 * Mobile bottom sheet wrapping the existing `<ChatPanel/>` body.
 *
 * Per `06-integration-plan-mobile.md §2.10` (slot `"chatSheet"` per the plan;
 * we use the AS-SHIPPED short slot `"chat"` from `overlayStore.ts`).
 *
 * Drives open state through the shared `overlayStore`. Mutex semantics in the
 * store auto-close any other slot that was previously open (kills the chat ↔
 * admin double-overlay bug from `02-scan-navigation.md §5.1`).
 *
 * A11y: vaul wraps Radix Dialog → `role="dialog"` + `aria-modal="true"` +
 * focus-trap + Esc-to-close are inherited. Adds `aria-label="Чат"`.
 */

interface MobileChatSheetProps {
  onImageClick?: (src: string) => void;
}

export default function MobileChatSheet({ onImageClick }: MobileChatSheetProps) {
  const open = useOverlay("chat");
  const openOverlay = useOverlayStore((s) => s.openOverlay);
  const closeOverlay = useOverlayStore((s) => s.closeOverlay);

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(o) => {
        if (o) openOverlay("chat");
        else closeOverlay();
      }}
      shouldScaleBackground
      dismissible
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/50 z-modal" />
        <Drawer.Content
          aria-label="Чат"
          className="fixed inset-x-0 bottom-0 z-modal h-[95dvh] bg-surface rounded-t-2xl flex flex-col pb-safe outline-none"
        >
          <div className="mx-auto h-1.5 w-12 my-2 rounded-full bg-border flex-shrink-0" />
          <Drawer.Title className="sr-only">Чат</Drawer.Title>
          <Drawer.Description className="sr-only">
            Чат проекта и watercooler
          </Drawer.Description>
          <div className="flex-1 min-h-0 overflow-hidden">
            <ChatPanel onImageClick={onImageClick} />
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
