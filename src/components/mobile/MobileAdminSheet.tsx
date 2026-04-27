"use client";

import { Drawer } from "vaul";
import { useOverlay, useOverlayStore } from "@/lib/overlayStore";
import AdminPanel from "@/components/AdminPanel";

/**
 * Mobile full-height sheet wrapping `<AdminPanel/>`.
 *
 * Per `06-integration-plan-mobile.md §2.13` (slot `"adminSheet"` per the plan;
 * we use the AS-SHIPPED short slot `"admin"` from `overlayStore.ts`).
 *
 * A11y: vaul → Radix Dialog. `aria-label="Пользователи"`.
 */

interface MobileAdminSheetProps {
  onPendingCountChange?: (count: number) => void;
}

export default function MobileAdminSheet({ onPendingCountChange }: MobileAdminSheetProps) {
  const open = useOverlay("admin");
  const openOverlay = useOverlayStore((s) => s.openOverlay);
  const closeOverlay = useOverlayStore((s) => s.closeOverlay);

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(o) => {
        if (o) openOverlay("admin");
        else closeOverlay();
      }}
      shouldScaleBackground
      dismissible
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/50 z-modal" />
        <Drawer.Content
          aria-label="Пользователи"
          className="fixed inset-x-0 bottom-0 z-modal h-[95dvh] bg-surface rounded-t-2xl flex flex-col pb-safe outline-none"
        >
          <div className="mx-auto h-1.5 w-12 my-2 rounded-full bg-border flex-shrink-0" />
          <Drawer.Title className="sr-only">Пользователи</Drawer.Title>
          <Drawer.Description className="sr-only">
            Управление пользователями
          </Drawer.Description>
          <div className="flex-1 min-h-0 overflow-hidden">
            <AdminPanel onPendingCountChange={onPendingCountChange} />
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
