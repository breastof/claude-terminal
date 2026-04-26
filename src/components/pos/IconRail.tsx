"use client";

import {
  TerminalIcon,
  BookOpen,
  Settings,
  Puzzle,
  Brain,
  Music,
  Monitor,
  Sun,
  Moon,
  Keyboard,
  LogOut,
} from "@/components/Icons";
import { useNavigation, type Section } from "@/lib/NavigationContext";
import { useTheme } from "@/lib/ThemeContext";
import { useOverlayStore } from "@/lib/overlayStore";

interface IconRailProps {
  onLogout: () => void;
  systemAlerts?: boolean;
}

const SECTIONS: { id: Section; icon: typeof TerminalIcon; label: string }[] = [
  { id: "sessions", icon: TerminalIcon, label: "Сессии" },
  { id: "hub", icon: BookOpen, label: "Hub" },
  { id: "config", icon: Settings, label: "Конфигурация" },
  { id: "skills", icon: Puzzle, label: "Скиллы" },
  { id: "memory", icon: Brain, label: "Память" },
  { id: "symphony", icon: Music, label: "Symphony" },
  { id: "system", icon: Monitor, label: "Система" },
];

/**
 * Desktop icon rail (≥768 px).
 *
 * Per `06-integration-plan-mobile.md §3.8`, the previously-local
 * `HotkeysModal` mount is removed; pressing the keyboard button now flips
 * the shared `overlayStore` slot `"hotkeysModal"`. The modal itself is
 * mounted at the dashboard page level (WP-D).
 */
export default function IconRail({ onLogout, systemAlerts }: IconRailProps) {
  const { activeSection, setActiveSection, panelOpen, setPanelOpen } = useNavigation();
  const { theme, toggleTheme } = useTheme();
  const openOverlay = useOverlayStore((s) => s.openOverlay);

  const FULL_WIDTH_SECTIONS: Section[] = ["symphony", "system"];

  const handleSectionClick = (section: Section) => {
    if (activeSection === section) {
      setPanelOpen(!panelOpen);
    } else {
      setActiveSection(section);
      setPanelOpen(!FULL_WIDTH_SECTIONS.includes(section));
    }
  };

  return (
    <div className="w-12 flex-shrink-0 flex flex-col bg-surface border-r border-border h-full">
      {/* Section icons */}
      <div className="flex-1 flex flex-col items-center pt-2 gap-0.5">
        {SECTIONS.map(({ id, icon: Icon, label }) => {
          const isActive = activeSection === id;
          const showAlert = id === "system" && systemAlerts;
          return (
            <button
              key={id}
              onClick={() => handleSectionClick(id)}
              className={`relative w-10 h-10 flex items-center justify-center rounded-lg transition-all cursor-pointer group ${
                isActive
                  ? "bg-accent-muted text-accent-fg"
                  : "text-muted-fg hover:text-foreground hover:bg-surface-hover"
              }`}
              title={label}
              aria-label={label}
            >
              {isActive && (
                <div className="absolute left-0 top-2 bottom-2 w-0.5 bg-accent-fg rounded-r" />
              )}
              <Icon className="w-[18px] h-[18px]" />
              {showAlert && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-danger rounded-full" />
              )}
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex flex-col items-center pb-3 gap-1 border-t border-border pt-2">
        <button
          onClick={toggleTheme}
          className="w-10 h-10 flex items-center justify-center rounded-lg text-muted-fg hover:text-foreground hover:bg-surface-hover transition-all cursor-pointer"
          title={theme === "dark" ? "Ретро тема" : "Тёмная тема"}
          aria-label={theme === "dark" ? "Ретро тема" : "Тёмная тема"}
        >
          {theme === "dark" ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
        </button>
        <button
          onClick={() => openOverlay("hotkeys")}
          className="w-10 h-10 flex items-center justify-center rounded-lg text-muted-fg hover:text-foreground hover:bg-surface-hover transition-all cursor-pointer"
          title="Горячие клавиши"
          aria-label="Горячие клавиши"
        >
          <Keyboard className="w-[18px] h-[18px]" />
        </button>
        <button
          onClick={onLogout}
          className="w-10 h-10 flex items-center justify-center rounded-lg text-muted-fg hover:text-danger hover:bg-surface-hover transition-all cursor-pointer"
          title="Выйти"
          aria-label="Выйти"
        >
          <LogOut className="w-[18px] h-[18px]" />
        </button>
      </div>
    </div>
  );
}
