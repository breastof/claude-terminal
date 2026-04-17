"use client";

import { TerminalIcon, BookOpen, Music, Monitor, MoreHorizontal, Settings, Puzzle, Brain } from "@/components/Icons";
import { useNavigation, type Section } from "@/lib/NavigationContext";
import { useState } from "react";

const MAIN_TABS: { id: Section; icon: typeof TerminalIcon; label: string }[] = [
  { id: "sessions", icon: TerminalIcon, label: "Сессии" },
  { id: "hub", icon: BookOpen, label: "Hub" },
  { id: "symphony", icon: Music, label: "Задачи" },
  { id: "system", icon: Monitor, label: "Система" },
];

const MORE_TABS: { id: Section; icon: typeof TerminalIcon; label: string }[] = [
  { id: "config", icon: Settings, label: "Конфиг" },
  { id: "skills", icon: Puzzle, label: "Скиллы" },
  { id: "memory", icon: Brain, label: "Память" },
];

export default function MobileBottomBar() {
  const { activeSection, setActiveSection, setPanelOpen } = useNavigation();
  const [moreOpen, setMoreOpen] = useState(false);

  const FULL_WIDTH_SECTIONS: Section[] = ["symphony", "system"];

  const handleTab = (section: Section) => {
    setActiveSection(section);
    setPanelOpen(!FULL_WIDTH_SECTIONS.includes(section));
    setMoreOpen(false);
  };

  return (
    <>
      {/* Overflow menu */}
      {moreOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} />
          <div className="fixed bottom-14 right-2 z-50 bg-surface border border-border rounded-lg shadow-lg p-1 min-w-[140px]">
            {MORE_TABS.map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => handleTab(id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
                  activeSection === id ? "bg-accent-muted text-accent-fg" : "text-foreground hover:bg-surface-hover"
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Bottom bar */}
      <div className="md:hidden h-14 border-t border-border bg-surface flex items-center justify-around px-2">
        {MAIN_TABS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => handleTab(id)}
            className={`flex flex-col items-center gap-0.5 px-3 py-1 rounded-md transition-colors cursor-pointer ${
              activeSection === id ? "text-accent-fg" : "text-muted-fg"
            }`}
          >
            <Icon className="w-5 h-5" />
            <span className="text-[10px]">{label}</span>
          </button>
        ))}
        <button
          onClick={() => setMoreOpen(!moreOpen)}
          className={`flex flex-col items-center gap-0.5 px-3 py-1 rounded-md transition-colors cursor-pointer ${
            MORE_TABS.some(t => t.id === activeSection) ? "text-accent-fg" : "text-muted-fg"
          }`}
        >
          <MoreHorizontal className="w-5 h-5" />
          <span className="text-[10px]">Ещё</span>
        </button>
      </div>
    </>
  );
}
