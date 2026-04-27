"use client";

import { useNavigation } from "@/lib/NavigationContext";
import { useVisualViewport } from "@/lib/useVisualViewport";
import { useIsMobile } from "@/lib/useIsMobile";
import IconRail from "@/components/pos/IconRail";
import SidePanel from "@/components/pos/SidePanel";
import MobileBottomBar from "@/components/pos/MobileBottomBar";
import { AnimatePresence, motion } from "motion/react";
import { X } from "@/components/Icons";
import { type ReactNode } from "react";

interface DashboardLayoutProps {
  children: ReactNode;
  fullscreen: boolean;
  // Session panel props
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onSessionDeleted: (sessionId: string) => void;
  onNewSession: (providerSlug: string) => void;
  onOpenFiles?: (sessionId: string) => void;
  onResumeSession?: (sessionId: string) => void;
  resumingSessionId?: string | null;
  creatingSession?: boolean;
  onLogout: () => void;
  systemAlerts?: boolean;
  // Mobile sidebar
  mobileSidebarOpen: boolean;
  onCloseMobileSidebar: () => void;
  // Optional mobile footer slot (composer). Rendered in-flow ABOVE the
  // MobileBottomBar so the column-flex stack keeps everything stable
  // across iOS Safari visualViewport quirks. Pass null on desktop.
  mobileFooter?: ReactNode;
}

export default function DashboardLayout({
  children,
  fullscreen,
  activeSessionId,
  onSelectSession,
  onSessionDeleted,
  onNewSession,
  onOpenFiles,
  onResumeSession,
  resumingSessionId,
  creatingSession,
  onLogout,
  systemAlerts,
  mobileSidebarOpen,
  onCloseMobileSidebar,
  mobileFooter,
}: DashboardLayoutProps) {
  const { panelOpen } = useNavigation();
  const isMobile = useIsMobile();
  // Registers visualViewport listeners and continuously writes the
  // `--vvh`, `--kbd-height`, `--vv-offset-top` CSS vars to :root.
  // Per `06-integration-plan-mobile.md §3.5 WP-A` — the hook is called
  // for its side effect; the returned state is consumed by mobile-only
  // components (modifier bar, mobile bottom bar) elsewhere.
  useVisualViewport();

  if (fullscreen) {
    return (
      <div
        className="flex flex-col md:flex-row bg-background overflow-hidden w-full h-full"
      >
        {children}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col md:flex-row bg-background overflow-hidden w-full h-full"
    >
      {/* Desktop: Icon Rail + Side Panel */}
      <div className="hidden md:flex h-full">
        <IconRail onLogout={onLogout} systemAlerts={systemAlerts} />
        {panelOpen && (
          <SidePanel
            activeSessionId={activeSessionId}
            onSelectSession={onSelectSession}
            onSessionDeleted={onSessionDeleted}
            onNewSession={onNewSession}
            onOpenFiles={onOpenFiles}
            onResumeSession={onResumeSession}
            resumingSessionId={resumingSessionId}
            creatingSession={creatingSession}
          />
        )}
      </div>

      {/* Legacy mobile sidebar overlay (IconRail + SidePanel slide-in).
          Gated to `!isMobile` so the duplicate nav surface vanishes on phones —
          MobileSessionsSheet + MobileMoreSheet now own that responsibility per
          `09-audit-mobile.md §5.3`. Tablet/desktop callers (which never set
          `mobileSidebarOpen`) are unaffected. */}
      {!isMobile && (
        <AnimatePresence>
          {mobileSidebarOpen && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 bg-black/60 z-30 md:hidden"
                onClick={onCloseMobileSidebar}
              />
              <motion.div
                initial={{ x: "-100%" }}
                animate={{ x: 0 }}
                exit={{ x: "-100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed top-0 left-0 bottom-0 z-40 md:hidden flex"
              >
                <IconRail onLogout={onLogout} systemAlerts={systemAlerts} />
                <div className="w-[280px] bg-surface border-r border-border relative">
                  <div className="absolute top-3 right-3 z-50">
                    <button
                      onClick={onCloseMobileSidebar}
                      className="p-2 text-muted-fg hover:text-foreground transition-colors"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  <SidePanel
                    activeSessionId={activeSessionId}
                    onSelectSession={onSelectSession}
                    onSessionDeleted={onSessionDeleted}
                    onNewSession={onNewSession}
                    onOpenFiles={onOpenFiles}
                    onResumeSession={onResumeSession}
                    resumingSessionId={resumingSessionId}
                    creatingSession={creatingSession}
                  />
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      )}

      {/* Main content area + mobile footer (composer) + tabbar — all
          in the same column so iOS Safari visualViewport quirks don't
          desync a fixed-positioned composer from the in-flow tabbar.
          The composer is rendered ABOVE the tabbar; both self-gate to
          mobile via internal `useIsMobile`. */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="flex-1 flex flex-col min-h-0">
          {children}
        </div>
        {mobileFooter}
        <MobileBottomBar />
      </div>
    </div>
  );
}
