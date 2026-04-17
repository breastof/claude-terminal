"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export type Section = "sessions" | "hub" | "config" | "skills" | "memory" | "symphony" | "system";

export type WorkspaceView =
  | { type: "welcome" }
  | { type: "terminal"; sessionId: string }
  | { type: "files"; sessionId: string; initialFile?: string }
  | { type: "explorer"; root: string; path?: string; openFile?: string }
  | { type: "skill"; name: string }
  | { type: "memory"; projectKey: string }
  | { type: "symphony" }
  | { type: "system" };

interface NavigationContextValue {
  activeSection: Section;
  setActiveSection: (section: Section) => void;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  workspaceView: WorkspaceView;
  setWorkspaceView: (view: WorkspaceView) => void;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

function getInitialSection(): Section {
  if (typeof window === "undefined") return "sessions";
  try {
    return (localStorage.getItem("pos_section") as Section) || "sessions";
  } catch {
    return "sessions";
  }
}

function getInitialPanelOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const v = localStorage.getItem("pos_panel");
    return v !== "false";
  } catch {
    return true;
  }
}

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [activeSection, setActiveSectionRaw] = useState<Section>(getInitialSection);
  const [panelOpen, setPanelOpenRaw] = useState(getInitialPanelOpen);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>({ type: "welcome" });

  const setActiveSection = useCallback((section: Section) => {
    setActiveSectionRaw(section);
    try { localStorage.setItem("pos_section", section); } catch {}
  }, []);

  const setPanelOpen = useCallback((open: boolean) => {
    setPanelOpenRaw(open);
    try { localStorage.setItem("pos_panel", String(open)); } catch {}
  }, []);

  const togglePanel = useCallback(() => {
    setPanelOpen(!panelOpen);
  }, [panelOpen, setPanelOpen]);

  return (
    <NavigationContext.Provider
      value={{
        activeSection,
        setActiveSection,
        panelOpen,
        setPanelOpen,
        togglePanel,
        workspaceView,
        setWorkspaceView,
      }}
    >
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation() {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error("useNavigation must be used within NavigationProvider");
  return ctx;
}
