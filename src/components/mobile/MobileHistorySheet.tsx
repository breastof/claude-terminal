"use client";

import { Drawer } from "vaul";
import { useOverlay, useOverlayStore } from "@/lib/overlayStore";
import HistoryViewer from "@/components/history/HistoryViewer";

/**
 * Mobile full-height drawer wrapping `<HistoryViewer/>`.
 *
 * Slot `"history"` (mutex per `overlayStore`). Same pattern as
 * `MobileFilesSheet` but no `onUserClose` — history is overlay-only and
 * doesn't swap workspace view.
 */

interface MobileHistorySheetProps {
  sessionId: string;
}

export default function MobileHistorySheet({ sessionId }: MobileHistorySheetProps) {
  const open = useOverlay("history");
  const openOverlay = useOverlayStore((s) => s.openOverlay);
  const closeOverlay = useOverlayStore((s) => s.closeOverlay);

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(o) => {
        if (o) openOverlay("history");
        else closeOverlay();
      }}
      shouldScaleBackground
      dismissible
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/50 z-modal" />
        <Drawer.Content
          aria-label="История"
          className="fixed inset-x-0 bottom-0 z-modal h-[100dvh] bg-surface rounded-t-2xl flex flex-col pb-safe outline-none"
        >
          <div className="mx-auto h-1.5 w-12 my-2 rounded-full bg-border flex-shrink-0" />
          <Drawer.Title className="sr-only">Полная история</Drawer.Title>
          <Drawer.Description className="sr-only">
            Полный лог терминальной сессии
          </Drawer.Description>
          <div className="flex-1 min-h-0 overflow-hidden">
            <HistoryViewer sessionId={sessionId} onClose={() => closeOverlay()} />
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
