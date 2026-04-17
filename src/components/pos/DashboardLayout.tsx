"use client";

import { useNavigation } from "@/lib/NavigationContext";
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
}: DashboardLayoutProps) {
  const { panelOpen } = useNavigation();

  if (fullscreen) {
    return <div className="flex h-screen bg-background">{children}</div>;
  }

  return (
    <div className="flex h-screen bg-background">
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

      {/* Mobile sidebar overlay */}
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

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {children}
      </div>

      {/* Mobile bottom bar */}
      <MobileBottomBar />
    </div>
  );
}
