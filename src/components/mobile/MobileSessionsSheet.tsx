"use client";

import { Drawer } from "vaul";
import { useOverlay, useOverlayStore } from "@/lib/overlayStore";
import SessionPanel from "@/components/pos/SessionPanel";

/**
 * Mobile bottom sheet for the Sessions list.
 *
 * Wraps the existing `SessionPanel` body in a `vaul` drawer per
 * `06-integration-plan-mobile.md §2.9` (ownership reassigned to WP-B in the
 * impl prompt). Drives open state through the shared `overlayStore`
 * (slot `"sessions"`).
 *
 * A11y: vaul wraps Radix Dialog → `role="dialog"` + `aria-modal="true"` +
 * focus-trap + Esc-to-close are inherited. We add `aria-label="Сессии"`.
 */

interface MobileSessionsSheetProps {
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onSessionDeleted: (sessionId: string) => void;
  onNewSession: (providerSlug: string) => void;
  onOpenFiles?: (sessionId: string) => void;
  onResumeSession?: (sessionId: string) => void;
  resumingSessionId?: string | null;
  creatingSession?: boolean;
}

export default function MobileSessionsSheet(props: MobileSessionsSheetProps) {
  const open = useOverlay("sessions");
  const openOverlay = useOverlayStore((s) => s.openOverlay);
  const closeOverlay = useOverlayStore((s) => s.closeOverlay);

  // Wrap every callback that mutates the active session so the sheet
  // auto-closes — otherwise the user clicks "Resume" / "New" / picks a
  // session and the sheet stays open over the terminal, looking like
  // nothing happened.
  const wrappedProps: MobileSessionsSheetProps = {
    ...props,
    onSelectSession: (id: string) => {
      props.onSelectSession(id);
      closeOverlay();
    },
    onResumeSession: props.onResumeSession
      ? (id: string) => {
          props.onResumeSession?.(id);
          closeOverlay();
        }
      : undefined,
    onNewSession: (slug: string) => {
      props.onNewSession(slug);
      closeOverlay();
    },
    onOpenFiles: props.onOpenFiles
      ? (id: string) => {
          props.onOpenFiles?.(id);
          closeOverlay();
        }
      : undefined,
  };

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(o) => {
        if (o) openOverlay("sessions");
        else closeOverlay();
      }}
      shouldScaleBackground
      dismissible
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/50 z-modal" />
        <Drawer.Content
          aria-label="Сессии"
          className="fixed inset-x-0 bottom-0 z-modal h-[90vh] bg-surface rounded-t-2xl flex flex-col pb-safe outline-none"
        >
          <div className="mx-auto h-1.5 w-12 my-2 rounded-full bg-border flex-shrink-0" />
          <Drawer.Title className="sr-only">Сессии</Drawer.Title>
          <Drawer.Description className="sr-only">
            Список активных и остановленных сессий терминала
          </Drawer.Description>
          <div className="flex-1 min-h-0 overflow-hidden">
            <SessionPanel {...wrappedProps} />
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
