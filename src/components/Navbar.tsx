"use client";

import { Wifi, WifiOff, Menu, ChevronLeft, ChevronRight, TerminalIcon, FolderIcon, MessageCircle, UsersIcon } from "@/components/Icons";
import { getProviderIcon } from "@/lib/provider-icons";
import SystemHealth from "@/components/SystemHealth";
import { useIsMobile } from "@/lib/useIsMobile";
import { useOverlayStore } from "@/lib/overlayStore";

export type ViewMode = "terminal" | "files";

interface NavbarProps {
  activeSessionId: string | null;
  activeSessionName?: string | null;
  providerSlug?: string;
  connectionStatus: "connected" | "disconnected" | "idle";
  sessionCount: { total: number; active: number };
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  onMenuClick?: () => void;
  viewMode?: ViewMode;
  onSwitchView?: (mode: ViewMode) => void;
  chatOpen?: boolean;
  onToggleChat?: () => void;
  isAdmin?: boolean;
  pendingCount?: number;
  adminOpen?: boolean;
  onToggleAdmin?: () => void;
}

export default function Navbar({
  activeSessionId,
  activeSessionName,
  providerSlug,
  connectionStatus,
  sessionCount,
  sidebarOpen,
  onToggleSidebar,
  onMenuClick,
  viewMode,
  onSwitchView,
  chatOpen,
  onToggleChat,
  isAdmin,
  pendingCount,
  adminOpen,
  onToggleAdmin,
}: NavbarProps) {
  const ProvIcon = providerSlug ? getProviderIcon(providerSlug) : null;
  const isMobile = useIsMobile();
  const openOverlay = useOverlayStore((s) => s.openOverlay);

  // On mobile, the hamburger opens the consolidated MobileSessionsSheet
  // (canonical mobile entry point for the sessions list). Desktop keeps
  // the legacy callback (currently unused on desktop, but preserved for
  // tablet/edge breakpoints that hit the md:hidden branch).
  const handleMenuClick = () => {
    if (isMobile) {
      openOverlay("sessions");
    } else if (onMenuClick) {
      onMenuClick();
    }
  };

  return (
    <div className="h-14 border-b border-border flex items-center justify-between px-3 md:px-5 bg-surface backdrop-blur-xl">
      <div className="flex items-center gap-2">
        {/* Sidebar toggle — desktop only */}
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className="hidden md:flex items-center justify-center w-7 h-7 rounded-md text-muted hover:text-muted-fg hover:bg-surface-hover transition-all cursor-pointer"
            title={sidebarOpen ? "Скрыть панель" : "Показать панель"}
          >
            {sidebarOpen ? (
              <ChevronLeft className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </button>
        )}

        {/* Hamburger — mobile only. Mobile path opens MobileSessionsSheet via
            overlayStore; desktop path falls through to the legacy onMenuClick
            (no-op when not provided). */}
        {(onMenuClick || isMobile) && (
          <button
            onClick={handleMenuClick}
            aria-label="Открыть меню"
            className="md:hidden p-2.5 -ml-1 text-muted-fg hover:text-foreground transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
        )}

        {activeSessionId && (
          <div className="flex items-center gap-1.5">
            {ProvIcon && <ProvIcon className="w-4 h-4 text-muted-fg" />}
            <span className="text-sm text-muted-fg font-mono truncate max-w-[150px] md:max-w-none">
              {activeSessionName || activeSessionId}
            </span>
          </div>
        )}

        {/* View mode toggle */}
        {activeSessionId && viewMode && onSwitchView && (
          <div role="tablist" aria-label="View mode" className="flex items-center gap-0.5 ml-2 bg-surface-alt rounded-lg p-0.5 border border-border">
            <button
              role="tab"
              aria-selected={viewMode === "terminal"}
              onClick={() => onSwitchView("terminal")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-all cursor-pointer ${
                viewMode === "terminal"
                  ? "bg-accent-muted text-accent-fg"
                  : "text-muted-fg hover:text-foreground"
              }`}
            >
              <TerminalIcon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Терминал</span>
            </button>
            <button
              role="tab"
              aria-selected={viewMode === "files"}
              onClick={() => onSwitchView("files")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-all cursor-pointer ${
                viewMode === "files"
                  ? "bg-accent-muted text-accent-fg"
                  : "text-muted-fg hover:text-foreground"
              }`}
            >
              <FolderIcon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Файлы</span>
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        {/* Session counter */}
        <span className="text-xs text-muted hidden sm:inline">
          {sessionCount.total > 0
            ? `${sessionCount.total} сес. (${sessionCount.active} акт.)`
            : ""}
        </span>

        {/* Connection status */}
        {connectionStatus !== "idle" && (
          <div className="flex items-center gap-1.5">
            {connectionStatus === "connected" ? (
              <Wifi className="w-4 h-4 md:w-3.5 md:h-3.5 text-emerald-500" />
            ) : (
              <WifiOff className="w-4 h-4 md:w-3.5 md:h-3.5 text-muted-fg" />
            )}
          </div>
        )}

        {/* System health — admin only */}
        {isAdmin && <SystemHealth />}

        {/* Admin panel toggle — admin only */}
        {isAdmin && onToggleAdmin && (
          <button
            onClick={onToggleAdmin}
            aria-label="Пользователи"
            className={`relative p-2.5 md:p-1.5 rounded-md transition-all cursor-pointer ${
              adminOpen
                ? "border border-accent bg-accent-hover text-accent-fg"
                : "text-muted-fg hover:text-foreground border border-transparent"
            }`}
            title="Пользователи"
          >
            <UsersIcon className="w-5 h-5 md:w-4 md:h-4" />
            {!!pendingCount && pendingCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center px-1 text-[10px] font-bold bg-amber-500 text-white rounded-full">
                {pendingCount}
              </span>
            )}
          </button>
        )}

        {/* Chat toggle button */}
        {onToggleChat && (
          <button
            onClick={onToggleChat}
            aria-label="Чат"
            className={`p-2.5 md:p-1.5 rounded-md transition-all cursor-pointer ${
              chatOpen
                ? "border border-accent bg-accent-hover text-accent-fg"
                : "text-muted-fg hover:text-foreground border border-transparent"
            }`}
            title="Чат"
          >
            <MessageCircle className="w-5 h-5 md:w-4 md:h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
