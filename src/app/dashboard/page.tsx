"use client";

import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import Navbar, { ViewMode } from "@/components/Navbar";
import FileManager from "@/components/FileManager";
import StoppedSessionOverlay from "@/components/StoppedSessionOverlay";
import WelcomeScreen from "@/components/WelcomeScreen";
import { Maximize, Minimize, X } from "@/components/Icons";
import ProviderWizardModal from "@/components/ProviderWizardModal";
import ProviderConfigModal from "@/components/ProviderConfigModal";
import PresenceProvider, { usePresence } from "@/components/presence/PresenceProvider";
import CursorOverlay from "@/components/presence/CursorOverlay";
import { UserProvider, useUser } from "@/lib/UserContext";
import { ThemeProvider, useTheme } from "@/lib/ThemeContext";
import { themeConfigs } from "@/lib/theme-config";
import ChatPanel from "@/components/chat/ChatPanel";
import AdminPanel from "@/components/AdminPanel";
import ImageLightbox from "@/components/chat/ImageLightbox";
import { TerminalScrollProvider } from "@/lib/TerminalScrollContext";
import { TerminalIOProvider } from "@/lib/TerminalIOContext";
import { ProviderProvider, useProviders, type Provider } from "@/lib/ProviderContext";
import { EditorProvider, useEditor } from "@/lib/EditorContext";
import { NavigationProvider, useNavigation } from "@/lib/NavigationContext";
import DashboardLayout from "@/components/pos/DashboardLayout";
import FileExplorer from "@/components/pos/FileExplorer";
import SkillDetailView from "@/components/pos/SkillDetailView";
import MemoryDetailView from "@/components/pos/MemoryDetailView";
import SymphonyBoard from "@/components/pos/SymphonyBoard";
import { SymphonyProvider } from "@/lib/SymphonyContext";
import SymphonyDashboard from "@/components/symphony/SymphonyDashboard";
import SystemDashboard from "@/components/pos/SystemDashboard";
import { useIsMobile } from "@/lib/useIsMobile";
import { useVisualViewport } from "@/lib/useVisualViewport";
import { useOverlayStore } from "@/lib/overlayStore";
import HotkeysModal from "@/components/HotkeysModal";
import CommandPalette from "@/components/CommandPalette";
import MobileChatSheet from "@/components/mobile/MobileChatSheet";
import MobileFilesSheet from "@/components/mobile/MobileFilesSheet";
import MobileAdminSheet from "@/components/mobile/MobileAdminSheet";
import MobileSessionsSheet from "@/components/mobile/MobileSessionsSheet";
import MobileMoreSheet from "@/components/mobile/MobileMoreSheet";
import MobileComposer from "@/components/mobile/MobileComposer";

const Terminal = dynamic(() => import("@/components/Terminal"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full">
      <div className="animate-spin h-8 w-8 border-2 border-accent border-t-transparent rounded-full" />
    </div>
  ),
});

export default function Dashboard() {
  return (
    <Suspense>
      <ThemeProvider>
        <UserProvider>
          <PresenceProvider>
            <ProviderProvider>
              <EditorProvider>
                <NavigationProvider>
                  {/* TerminalIOProvider must wrap the WHOLE tree, not just
                      the terminal canvas — MobileComposer is rendered via
                      DashboardLayout's mobileFooter slot, OUTSIDE the
                      session-view scope, and it calls useTerminalIO() which
                      throws if the context is missing. Hoisting it here
                      keeps a single shared instance for both the terminal
                      and the composer. */}
                  <TerminalIOProvider>
                    <DashboardInner />
                  </TerminalIOProvider>
                </NavigationProvider>
              </EditorProvider>
            </ProviderProvider>
          </PresenceProvider>
        </UserProvider>
      </ThemeProvider>
    </Suspense>
  );
}

function DashboardInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialFile = searchParams.get("file");
  const { joinSession: presenceJoin, onPendingUser } = usePresence();
  const { theme } = useTheme();
  const { providers, refetch: refetchProviders } = useProviders();
  const { hasUnsavedChanges, requestClose } = useEditor();
  const { workspaceView, setWorkspaceView, activeSection, setActiveSection: navSetActiveSection } = useNavigation();
  const contentRef = useRef<HTMLDivElement>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeProviderSlug, setActiveProviderSlug] = useState<string>("claude");
  const [terminalKey, setTerminalKey] = useState(0);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<"connected" | "disconnected" | "idle">("idle");
  const [sessions, setSessions] = useState<Array<{sessionId: string; displayName: string | null; isActive: boolean; providerSlug: string}>>([]);
  const [viewMode, setViewMode] = useState<ViewMode>(initialFile ? "files" : "terminal");
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const { user } = useUser();
  const isAdmin = user?.role === "admin";
  const isMobile = useIsMobile();
  const { isKeyboardOpen } = useVisualViewport();
  const activeOverlay = useOverlayStore((s) => s.activeOverlay);

  // Welcome screen combo button state
  const [welcomeSelectedSlug, setWelcomeSelectedSlug] = useState<string>(() => {
    if (typeof window !== "undefined") return localStorage.getItem("selectedProvider") || "claude";
    return "claude";
  });
  const [welcomeWizardOpen, setWelcomeWizardOpen] = useState(false);
  const [welcomeConfigProvider, setWelcomeConfigProvider] = useState<Provider | null>(null);

  // Fetch pending count for admin
  useEffect(() => {
    if (!isAdmin) return;
    const fetchPending = async () => {
      try {
        const res = await fetch("/api/admin/users");
        if (res.ok) {
          const data = await res.json();
          setPendingCount(data.users.filter((u: { status: string }) => u.status === "pending").length);
        }
      } catch {}
    };
    fetchPending();
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    onPendingUser(() => setPendingCount((c) => c + 1));
  }, [isAdmin, onPendingUser]);

  const sessionCount = {
    total: sessions.length,
    active: sessions.filter((s) => s.isActive).length,
  };

  const activeSession = activeSessionId ? sessions.find((s) => s.sessionId === activeSessionId) : null;
  const activeSessionName = activeSession?.displayName || null;
  const isActiveSessionStopped = activeSession ? !activeSession.isActive : false;

  // Fetch sessions
  useEffect(() => {
    const fetchSessions = async () => {
      try {
        const res = await fetch("/api/sessions");
        if (res.ok) {
          const data = await res.json();
          setSessions(data.sessions);
        }
      } catch {}
    };
    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  // Auto-select session when arriving via ?file= param
  useEffect(() => {
    if (initialFile && !activeSessionId && sessions.length > 0) {
      const target = sessions[0];
      if (target) setActiveSessionId(target.sessionId);
    }
  }, [initialFile, activeSessionId, sessions]);

  // Warn before closing tab
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if ((activeSessionId && connectionStatus === "connected") || hasUnsavedChanges) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [activeSessionId, connectionStatus, hasUnsavedChanges]);

  // Sync active session to presence
  useEffect(() => {
    if (activeSessionId) presenceJoin(activeSessionId);
  }, [activeSessionId, presenceJoin]);

  // Track provider of active session
  useEffect(() => {
    if (activeSession?.providerSlug) setActiveProviderSlug(activeSession.providerSlug);
  }, [activeSession]);

  // Escape to exit fullscreen
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && fullscreen) setFullscreen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [fullscreen]);

  // Close any open mobile overlay when entering fullscreen —
  // otherwise a sheet opened before toggle stays visually on top of
  // the fullscreen terminal (overlayStore is not cleared by DashboardLayout).
  useEffect(() => {
    if (fullscreen) {
      useOverlayStore.getState().closeAll();
    }
  }, [fullscreen]);

  // Bidirectional sync: mobile chatOpen ↔ overlayStore "chat".
  // Desktop continues to use the AnimatePresence slide-overs gated by chatOpen
  // directly; only mobile drives the overlayStore (mutex source of truth).
  useEffect(() => {
    if (!isMobile) return;
    const store = useOverlayStore.getState();
    if (chatOpen && store.activeOverlay !== "chat") {
      store.openOverlay("chat");
    } else if (!chatOpen && store.activeOverlay === "chat") {
      store.closeOverlay();
    }
  }, [chatOpen, isMobile]);

  // Inverse sync: when overlayStore moves away from "chat" (e.g. mutex closed
  // it because the user opened "files"), reflect into local chatOpen so that
  // the Navbar toggle button visually updates.
  useEffect(() => {
    if (!isMobile) return;
    if (activeOverlay !== "chat" && chatOpen) setChatOpen(false);
    if (activeOverlay === "chat" && !chatOpen) setChatOpen(true);
  }, [activeOverlay, isMobile, chatOpen]);

  // Same for admin.
  useEffect(() => {
    if (!isMobile) return;
    const store = useOverlayStore.getState();
    if (adminOpen && store.activeOverlay !== "admin") {
      store.openOverlay("admin");
    } else if (!adminOpen && store.activeOverlay === "admin") {
      store.closeOverlay();
    }
  }, [adminOpen, isMobile]);

  useEffect(() => {
    if (!isMobile) return;
    if (activeOverlay !== "admin" && adminOpen) setAdminOpen(false);
    if (activeOverlay === "admin" && !adminOpen) setAdminOpen(true);
  }, [activeOverlay, isMobile, adminOpen]);

  // viewMode "files" on mobile → open MobileFilesSheet via overlayStore.
  // Switching back to "terminal" (or unmounting the session) closes it.
  useEffect(() => {
    if (!isMobile) return;
    const store = useOverlayStore.getState();
    if (viewMode === "files" && activeSessionId) {
      if (store.activeOverlay !== "files") store.openOverlay("files");
    } else {
      if (store.activeOverlay === "files") store.closeOverlay();
    }
  }, [viewMode, isMobile, activeSessionId]);

  // Inverse-sync removed: race с forward-sync вызывал отскок viewMode→"terminal"
  // в том же commit phase где openOverlay("files") только что выполнился. Закрытие
  // теперь user-initiated через `onUserClose` callback в `<MobileFilesSheet>`.

  const handleLogout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
  }, [router]);

  const VIEW_MODE_KEY = (sid: string) => `session-viewmode-${sid}`;

  const handleSelectSession = useCallback(async (sessionId: string) => {
    if (hasUnsavedChanges) {
      const canProceed = await requestClose();
      if (!canProceed) return;
    }
    // Save current viewMode for outgoing session
    if (activeSessionId) {
      try { sessionStorage.setItem(VIEW_MODE_KEY(activeSessionId), viewMode); } catch {}
    }
    setActiveSessionId(sessionId);
    setTerminalKey((k) => k + 1);
    setConnectionStatus("idle");
    setMobileSidebarOpen(false);
    // Restore viewMode for incoming session
    const saved = sessionStorage.getItem(VIEW_MODE_KEY(sessionId)) as ViewMode | null;
    const restored = saved === "files" ? "files" : "terminal";
    setViewMode(restored);
    navSetActiveSection("sessions");
    setWorkspaceView(restored === "files" ? { type: "files", sessionId } : { type: "terminal", sessionId });
  }, [hasUnsavedChanges, requestClose, setWorkspaceView, navSetActiveSection, activeSessionId, viewMode]);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    if (activeSessionId === sessionId) {
      setActiveSessionId(null);
      setConnectionStatus("idle");
      setViewMode("terminal");
      setWorkspaceView({ type: "welcome" });
    }
  }, [activeSessionId, setWorkspaceView]);

  const handleNewSession = useCallback(async (providerSlug: string = "claude", projectDir?: string) => {
    setCreatingSession(true);
    try {
      const body: Record<string, string> = { providerSlug };
      if (projectDir) body.projectDir = projectDir;
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        setActiveSessionId(data.sessionId);
        setTerminalKey((k) => k + 1);
        setConnectionStatus("idle");
        setMobileSidebarOpen(false);
        setViewMode("terminal");
        setWorkspaceView({ type: "terminal", sessionId: data.sessionId });
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Не удалось создать сессию");
      }
    } catch {} finally {
      setCreatingSession(false);
    }
  }, [setWorkspaceView]);

  const handleConnectionChange = useCallback((status: "connected" | "disconnected") => {
    setConnectionStatus(status);
  }, []);

  const handleOpenFiles = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    setViewMode("files");
    setMobileSidebarOpen(false);
    setWorkspaceView({ type: "files", sessionId });
  }, [setWorkspaceView]);

  const handleSwitchView = useCallback(async (mode: ViewMode) => {
    if (hasUnsavedChanges && mode !== viewMode) {
      const canProceed = await requestClose();
      if (!canProceed) return;
    }
    setViewMode(mode);
    if (activeSessionId) {
      try { sessionStorage.setItem(VIEW_MODE_KEY(activeSessionId), mode); } catch {}
    }
    if (mode === "terminal") {
      // Do NOT bump terminalKey here — that fully destroys + recreates the
      // Terminal (new WS, blank flash, reconnect). We only bump it on a
      // genuine new session or explicit resume. Switching back to the
      // terminal view just unhides the already-running canvas.
      if (activeSessionId) setWorkspaceView({ type: "terminal", sessionId: activeSessionId });
    } else {
      if (activeSessionId) setWorkspaceView({ type: "files", sessionId: activeSessionId });
    }
  }, [hasUnsavedChanges, requestClose, viewMode, activeSessionId, setWorkspaceView]);

  const handleResumeSession = useCallback(async (sessionId?: string) => {
    const targetId = sessionId || activeSessionId;
    if (!targetId) return;
    setResumingSessionId(targetId);
    try {
      await fetch(`/api/sessions/${targetId}`, { method: "PUT" });
      setSessions((prev) => prev.map((s) => s.sessionId === targetId ? { ...s, isActive: true } : s));
      setActiveSessionId(targetId);
      setTerminalKey((k) => k + 1);
      setConnectionStatus("idle");
      setMobileSidebarOpen(false);
      setViewMode("terminal");
      setWorkspaceView({ type: "terminal", sessionId: targetId });
    } finally {
      setResumingSessionId(null);
    }
  }, [activeSessionId, setWorkspaceView]);

  // Welcome screen provider handlers
  const handleWelcomeSaveProvider = useCallback(async (data: {
    name: string; slug: string; command: string; resumeCommand: string; icon: string; color: string;
  }) => {
    const res = await fetch("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: data.name, slug: data.slug, command: data.command, resumeCommand: data.resumeCommand || null, icon: data.icon, color: data.color }),
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Ошибка"); }
    await refetchProviders();
    setWelcomeSelectedSlug(data.slug);
    try { localStorage.setItem("selectedProvider", data.slug); } catch {}
  }, [refetchProviders]);

  const handleWelcomeUpdateProvider = useCallback(async (slug: string, data: { name?: string; command?: string; resumeCommand?: string }) => {
    const res = await fetch(`/api/providers/${slug}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Ошибка"); }
    await refetchProviders();
  }, [refetchProviders]);

  const handleWelcomeDeleteProvider = useCallback(async (slug: string) => {
    const res = await fetch(`/api/providers/${slug}`, { method: "DELETE" });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Ошибка"); }
    await refetchProviders();
    if (welcomeSelectedSlug === slug) { setWelcomeSelectedSlug("claude"); try { localStorage.setItem("selectedProvider", "claude"); } catch {} }
  }, [refetchProviders, welcomeSelectedSlug]);

  // Determine what to show in main content based on workspace view + active section
  const isSessionView = activeSessionId && activeSection === "sessions";
  // Hide navbar on mobile when the soft keyboard is open — it reclaims 56px
  // for the terminal which otherwise renders into a tiny sliver.
  const showNavbar = !fullscreen && !(isMobile && isKeyboardOpen);

  // Sync workspace view when section changes
  useEffect(() => {
    switch (activeSection) {
      case "sessions":
        if (!activeSessionId) setWorkspaceView({ type: "welcome" });
        // if activeSessionId exists, keep current terminal/files view
        break;
      case "hub":
        setWorkspaceView({ type: "explorer", root: "hub" });
        break;
      case "config":
        setWorkspaceView({ type: "explorer", root: "config" });
        break;
      case "skills":
        if (workspaceView.type !== "skill") setWorkspaceView({ type: "welcome" });
        break;
      case "memory":
        if (workspaceView.type !== "memory") setWorkspaceView({ type: "welcome" });
        break;
      case "symphony":
        setWorkspaceView({ type: "symphony" });
        break;
      case "system":
        setWorkspaceView({ type: "system" });
        break;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection]);

  return (
    <DashboardLayout
      fullscreen={fullscreen}
      activeSessionId={activeSessionId}
      onSelectSession={handleSelectSession}
      onSessionDeleted={handleSessionDeleted}
      onNewSession={handleNewSession}
      onOpenFiles={handleOpenFiles}
      onResumeSession={handleResumeSession}
      resumingSessionId={resumingSessionId}
      creatingSession={creatingSession}
      onLogout={handleLogout}
      mobileSidebarOpen={mobileSidebarOpen}
      onCloseMobileSidebar={() => setMobileSidebarOpen(false)}
      mobileFooter={isSessionView ? <MobileComposer sessionId={activeSessionId} /> : undefined}
    >
      {/* Navbar */}
      {showNavbar && (
        <Navbar
          activeSessionId={activeSessionId}
          activeSessionName={activeSessionName}
          providerSlug={activeProviderSlug}
          connectionStatus={connectionStatus}
          sessionCount={sessionCount}
          onMenuClick={() => setMobileSidebarOpen(true)}
          viewMode={isSessionView ? viewMode : undefined}
          onSwitchView={isSessionView ? handleSwitchView : undefined}
          chatOpen={chatOpen}
          onToggleChat={() => setChatOpen(!chatOpen)}
          isAdmin={isAdmin}
          pendingCount={pendingCount}
          adminOpen={adminOpen}
          onToggleAdmin={() => setAdminOpen(!adminOpen)}
        />
      )}

      {/* Content area */}
      <div className="flex-1 relative min-h-0">
        {/* Session views: terminal + files */}
        {activeSessionId && activeSection === "sessions" && (
          <>
            {/* Desktop files stage; mobile uses MobileFilesSheet (see below). */}
            {!isMobile && (
              <div className={`absolute inset-0 m-1 md:m-2 ${viewMode === "files" ? "" : "hidden"}`}>
                <div className="w-full h-full rounded-xl border border-accent/20 bg-surface-alt overflow-hidden">
                  <FileManager sessionId={activeSessionId} initialFile={initialFile} visible={viewMode === "files"} />
                </div>
              </div>
            )}

            {/* Terminal stays mounted on mobile even when MobileFilesSheet is open
                (sheet is overlay, not page-replacement). Desktop hides terminal in files mode. */}
            {(isMobile || viewMode !== "files") && (
              isActiveSessionStopped ? (
                <div className="absolute inset-0 m-1 md:m-2">
                  <div className="w-full h-full rounded-xl border border-accent/20 bg-surface-alt overflow-hidden">
                    <StoppedSessionOverlay
                      sessionName={activeSessionName || activeSessionId}
                      onResume={handleResumeSession}
                      resuming={resumingSessionId === activeSessionId}
                    />
                  </div>
                </div>
              ) : (
                <TerminalScrollProvider>
                  <div ref={contentRef} className={`absolute inset-0 ${fullscreen ? "m-0" : "m-1 md:m-2"} presence-active`}>
                    <CursorOverlay />
                    <button
                      onClick={() => setFullscreen(!fullscreen)}
                      className="absolute top-2 right-2 z-10 p-2 md:p-1.5 text-muted hover:text-foreground transition-colors bg-surface-alt/80 rounded-md backdrop-blur-sm"
                      title={fullscreen ? "Выйти из полноэкранного" : "Полноэкранный режим"}
                    >
                      {fullscreen ? <Minimize className="w-5 h-5 md:w-4 md:h-4" /> : <Maximize className="w-5 h-5 md:w-4 md:h-4" />}
                    </button>
                    <div className="w-full h-full rounded-xl border border-border bg-surface-alt overflow-hidden p-1">
                      <div className="w-full h-full rounded-lg overflow-hidden" style={{ backgroundColor: themeConfigs[theme].terminal.background }}>
                        <Terminal key={terminalKey} sessionId={activeSessionId} fullscreen={fullscreen} onConnectionChange={handleConnectionChange} />
                      </div>
                    </div>
                    {/* ModifierKeyBar is now embedded inside MobileComposer —
                        no fixed overlay. Nothing to render here. */}
                  </div>
                </TerminalScrollProvider>
              )
            )}
          </>
        )}

        {/* Explorer views (hub, config) */}
        {workspaceView.type === "explorer" && (activeSection === "hub" || activeSection === "config") && (
          <div className="absolute inset-0 m-1 md:m-2">
            <div className="w-full h-full rounded-xl border border-accent/20 bg-surface-alt overflow-hidden">
              <FileExplorer root={workspaceView.root} initialPath={workspaceView.path} initialFile={workspaceView.openFile} noTree />
            </div>
          </div>
        )}

        {/* Skill detail */}
        {workspaceView.type === "skill" && activeSection === "skills" && (
          <div className="absolute inset-0 m-1 md:m-2">
            <div className="w-full h-full rounded-xl border border-accent/20 bg-surface-alt overflow-hidden">
              <SkillDetailView name={workspaceView.name} />
            </div>
          </div>
        )}

        {/* Memory detail */}
        {workspaceView.type === "memory" && activeSection === "memory" && (
          <div className="absolute inset-0 m-1 md:m-2">
            <div className="w-full h-full rounded-xl border border-accent/20 bg-surface-alt overflow-hidden">
              <MemoryDetailView projectKey={workspaceView.projectKey} />
            </div>
          </div>
        )}

        {/* Symphony */}
        {workspaceView.type === "symphony" && activeSection === "symphony" && (
          <div className="absolute inset-0 m-1 md:m-2">
            <div className="w-full h-full rounded-xl border border-accent/20 bg-surface-alt overflow-hidden">
              <SymphonyProvider>
                <SymphonyDashboard />
              </SymphonyProvider>
            </div>
          </div>
        )}

        {/* System dashboard */}
        {workspaceView.type === "system" && activeSection === "system" && (
          <div className="absolute inset-0 m-1 md:m-2">
            <div className="w-full h-full rounded-xl border border-accent/20 bg-surface-alt overflow-hidden">
              <SystemDashboard />
            </div>
          </div>
        )}

        {/* Welcome screen — sessions section without active session */}
        {workspaceView.type === "welcome" && !activeSessionId && activeSection === "sessions" && activeOverlay === "none" && (
          <WelcomeScreen
            providers={providers}
            selectedSlug={welcomeSelectedSlug}
            onSelectSlug={(slug) => { setWelcomeSelectedSlug(slug); try { localStorage.setItem("selectedProvider", slug); } catch {} }}
            onCreateSession={handleNewSession}
            onAddProvider={() => setWelcomeWizardOpen(true)}
            onConfigureProvider={(p) => setWelcomeConfigProvider(p)}
            creating={creatingSession}
          />
        )}

        {/* Placeholder for skills/memory when no item selected */}
        {workspaceView.type === "welcome" && (activeSection === "skills" || activeSection === "memory") && activeOverlay === "none" && (
          <div className="flex items-center justify-center h-full text-muted-fg text-sm">
            Выберите элемент в панели слева
          </div>
        )}

        {/* Admin panel — right slide-over (desktop ≥768 only; mobile uses MobileAdminSheet). */}
        {!isMobile && (
          <AnimatePresence>
            {adminOpen && isAdmin && (
              <>
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="fixed inset-0 bg-black/60 z-40 md:hidden" onClick={() => setAdminOpen(false)} />
                <motion.div initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", damping: 30, stiffness: 300 }} className="fixed md:absolute top-0 right-0 bottom-0 w-full sm:w-80 md:w-96 z-50 md:z-20 bg-surface border-l border-border">
                  <div className="absolute top-2 right-2 z-10 md:hidden">
                    <button onClick={() => setAdminOpen(false)} className="p-2 text-muted-fg hover:text-foreground transition-colors"><X className="w-5 h-5" /></button>
                  </div>
                  <AdminPanel onPendingCountChange={setPendingCount} />
                </motion.div>
              </>
            )}
          </AnimatePresence>
        )}

        {/* Chat panel — right slide-over (desktop ≥768 only; mobile uses MobileChatSheet). */}
        {!isMobile && (
          <AnimatePresence>
            {chatOpen && (
              <>
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="fixed inset-0 bg-black/60 z-40 md:hidden" onClick={() => setChatOpen(false)} />
                <motion.div initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", damping: 30, stiffness: 300 }} className="fixed md:absolute top-0 right-0 bottom-0 w-full sm:w-80 md:w-96 z-50 md:z-20 bg-surface border-l border-border">
                  <div className="absolute top-2 right-2 z-10 md:hidden">
                    <button onClick={() => setChatOpen(false)} className="p-2 text-muted-fg hover:text-foreground transition-colors"><X className="w-5 h-5" /></button>
                  </div>
                  <ChatPanel onImageClick={(src) => setLightboxSrc(src)} />
                </motion.div>
              </>
            )}
          </AnimatePresence>
        )}

        {/* Mobile overlays — sheets driven by overlayStore (mutex).
            All five mobile sheets are mounted here; useOverlay reads from a
            global Zustand store so location is irrelevant for behavior. */}
        {isMobile && (
          <>
            <MobileSessionsSheet
              activeSessionId={activeSessionId}
              onSelectSession={handleSelectSession}
              onSessionDeleted={handleSessionDeleted}
              onNewSession={handleNewSession}
              onOpenFiles={handleOpenFiles}
              onResumeSession={handleResumeSession}
              resumingSessionId={resumingSessionId}
              creatingSession={creatingSession}
            />
            <MobileMoreSheet onLogout={handleLogout} />
            <MobileChatSheet onImageClick={(src) => setLightboxSrc(src)} />
            {activeSessionId && (
              <MobileFilesSheet
                sessionId={activeSessionId}
                initialFile={initialFile}
                onUserClose={() => {
                  setViewMode("terminal");
                  setWorkspaceView({ type: "terminal", sessionId: activeSessionId });
                }}
              />
            )}
            {isAdmin && <MobileAdminSheet onPendingCountChange={setPendingCount} />}
          </>
        )}
      </div>

      {/* Image lightbox */}
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}

      {/* Welcome screen modals */}
      <ProviderWizardModal open={welcomeWizardOpen} onClose={() => setWelcomeWizardOpen(false)} onSave={handleWelcomeSaveProvider} />
      <ProviderConfigModal open={!!welcomeConfigProvider} provider={welcomeConfigProvider} onClose={() => setWelcomeConfigProvider(null)} onSave={handleWelcomeUpdateProvider} onDelete={handleWelcomeDeleteProvider} />

      {/* Page-level CommandPalette (Cmd+K) — desktop & mobile both eligible. */}
      <CommandPalette sessions={sessions} onSelectSession={handleSelectSession} />

      {/* Page-level HotkeysModal — driven by overlayStore slot "hotkeys". */}
      <HotkeysModal />
    </DashboardLayout>
  );
}
