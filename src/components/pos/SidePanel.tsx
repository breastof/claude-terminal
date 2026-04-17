"use client";

import { useNavigation } from "@/lib/NavigationContext";
import SessionPanel from "@/components/pos/SessionPanel";
import HubPanel from "@/components/pos/HubPanel";
import ConfigPanel from "@/components/pos/ConfigPanel";
import SkillsPanel from "@/components/pos/SkillsPanel";
import MemoryPanel from "@/components/pos/MemoryPanel";
import SymphonyPanel from "@/components/pos/SymphonyPanel";
import SystemPanel from "@/components/pos/SystemPanel";

interface SidePanelProps {
  // Session panel props
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onSessionDeleted: (sessionId: string) => void;
  onNewSession: (providerSlug: string) => void;
  onOpenFiles?: (sessionId: string) => void;
  onResumeSession?: (sessionId: string) => void;
  resumingSessionId?: string | null;
  creatingSession?: boolean;
}

export default function SidePanel({
  activeSessionId,
  onSelectSession,
  onSessionDeleted,
  onNewSession,
  onOpenFiles,
  onResumeSession,
  resumingSessionId,
  creatingSession,
}: SidePanelProps) {
  const { activeSection } = useNavigation();

  return (
    <div className="w-[280px] flex-shrink-0 border-r border-border bg-surface h-full overflow-hidden">
      {activeSection === "sessions" && (
        <SessionPanel
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
      {activeSection === "hub" && <HubPanel />}
      {activeSection === "config" && <ConfigPanel />}
      {activeSection === "skills" && <SkillsPanel />}
      {activeSection === "memory" && <MemoryPanel />}
      {activeSection === "symphony" && <SymphonyPanel />}
      {activeSection === "system" && <SystemPanel />}
    </div>
  );
}
