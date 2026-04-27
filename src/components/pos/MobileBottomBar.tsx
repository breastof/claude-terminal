"use client";

import {
  TerminalIcon,
  Files,
  MessageCircle,
  MoreHorizontal,
} from "@/components/Icons";
import { useNavigation } from "@/lib/NavigationContext";
import {
  useOverlayStore,
  useOverlay,
  type OverlayName,
} from "@/lib/overlayStore";
import { useVisualViewport } from "@/lib/useVisualViewport";
import { useComposerStore } from "@/lib/composerStore";

/**
 * Mobile bottom navigation bar.
 *
 * Per `06-integration-plan-mobile.md §3.6` and `05-decision-mobile.md §2.4`,
 * the four tabs are repurposed to (Терминал / Сессии / Чат / Ещё). The
 * legacy "Ещё" overflow popover is removed; the More tab now opens
 * `MobileMoreSheet` (full vaul drawer with all secondary nav).
 *
 * - Terminal tab: closes any active overlay; resets navigation to the
 *   sessions section so the terminal canvas is visible.
 * - Sessions tab: opens `MobileSessionsSheet` via the overlay store.
 * - Chat tab: opens `MobileChatSheet` via the overlay store.
 * - More tab: opens `MobileMoreSheet` via the overlay store.
 *
 * Hides itself entirely when the soft keyboard is open per `05 §5.1 / §12.6`.
 * Applies `pb-safe` for the iOS home indicator inset.
 */

type MainTab = "terminal" | "sessions" | "chat" | "more";

const MAIN_TABS: { id: MainTab; icon: typeof TerminalIcon; label: string }[] = [
  { id: "terminal", icon: TerminalIcon, label: "Терминал" },
  { id: "sessions", icon: Files, label: "Сессии" },
  { id: "chat", icon: MessageCircle, label: "Чат" },
  { id: "more", icon: MoreHorizontal, label: "Ещё" },
];

const TAB_TO_SLOT: Record<Exclude<MainTab, "terminal">, OverlayName> = {
  sessions: "sessions",
  chat: "chat",
  more: "more",
};

export default function MobileBottomBar() {
  const { activeSection, setActiveSection, setPanelOpen } = useNavigation();
  const openOverlay = useOverlayStore((s) => s.openOverlay);
  const closeOverlay = useOverlayStore((s) => s.closeOverlay);

  const sessionsOpen = useOverlay("sessions");
  const chatOpen = useOverlay("chat");
  const moreOpen = useOverlay("more");

  const { isKeyboardOpen } = useVisualViewport();
  const composerFocused = useComposerStore((s) => s.focused);

  // Hide when the soft keyboard is up OR when the composer textarea is focused.
  // The keyboard heuristic can lag on some Android WebViews; the focus signal
  // is reliable and fires synchronously, giving instant tabbar collapse.
  if (isKeyboardOpen || composerFocused) return null;

  const isTabActive = (tab: MainTab): boolean => {
    switch (tab) {
      case "terminal":
        // Active only when no overlay is open AND we are on the sessions
        // section (which is the canvas-default state on mobile).
        return !sessionsOpen && !chatOpen && !moreOpen && activeSection === "sessions";
      case "sessions":
        return sessionsOpen;
      case "chat":
        return chatOpen;
      case "more":
        return moreOpen;
    }
  };

  const handleTab = (tab: MainTab) => {
    if (tab === "terminal") {
      // Snap back to terminal canvas: close overlays, ensure sessions section
      // is selected so the active session is rendered.
      setActiveSection("sessions");
      setPanelOpen(false);
      closeOverlay();
      return;
    }
    openOverlay(TAB_TO_SLOT[tab]);
  };

  return (
    <div
      role="tablist"
      aria-label="Главная навигация"
      className="md:hidden h-10 border-t border-border bg-surface flex items-center justify-around px-2 pb-safe"
    >
      {MAIN_TABS.map(({ id, icon: Icon, label }) => {
        const active = isTabActive(id);
        return (
          <button
            key={id}
            role="tab"
            aria-selected={active}
            aria-label={label}
            onClick={() => handleTab(id)}
            className={`flex items-center justify-center w-10 h-8 rounded-md transition-colors cursor-pointer ${
              active ? "text-accent-fg" : "text-muted-fg"
            }`}
          >
            <Icon className="w-5 h-5" />
          </button>
        );
      })}
    </div>
  );
}
