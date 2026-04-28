"use client";

import { Drawer } from "vaul";
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
  ScrollText,
} from "@/components/Icons";
import { useNavigation, type Section } from "@/lib/NavigationContext";
import { useTheme } from "@/lib/ThemeContext";
import { useOverlay, useOverlayStore } from "@/lib/overlayStore";

/**
 * Mobile left-edge drawer hosting secondary navigation that does NOT fit on
 * the 4-tab bottom bar: Hub, Config, Skills, Memory, Symphony, System, plus
 * Hotkeys and Logout.
 *
 * Per `06-integration-plan-mobile.md §2.11` (ownership reassigned to WP-B in
 * the impl prompt). Layout is inlined (not via `<IconRail/>`) so the bigger
 * sheet width can host labels + the row uses 44 px tap targets instead of
 * IconRail's 40 px desktop sizing.
 *
 * A11y: vaul → Radix Dialog → `role="dialog"` + `aria-modal` + focus-trap +
 * Esc-to-close. Adds `aria-label="Главное меню"`.
 */

interface MobileMoreSheetProps {
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

export default function MobileMoreSheet({ onLogout, systemAlerts }: MobileMoreSheetProps) {
  const open = useOverlay("more");
  const openOverlay = useOverlayStore((s) => s.openOverlay);
  const closeOverlay = useOverlayStore((s) => s.closeOverlay);
  const { activeSection, setActiveSection, setPanelOpen } = useNavigation();
  const { theme, toggleTheme } = useTheme();

  const FULL_WIDTH_SECTIONS: Section[] = ["symphony", "system"];

  const handleSectionClick = (section: Section) => {
    setActiveSection(section);
    setPanelOpen(!FULL_WIDTH_SECTIONS.includes(section));
    closeOverlay(); // close drawer after section change
  };

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(o) => {
        if (o) openOverlay("more");
        else closeOverlay();
      }}
      direction="left"
      dismissible
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/60 z-modal" />
        <Drawer.Content
          aria-label="Главное меню"
          className="fixed top-0 left-0 bottom-0 z-modal w-[280px] bg-surface border-r border-border flex flex-col pt-safe pb-safe outline-none"
        >
          <Drawer.Title className="sr-only">Главное меню</Drawer.Title>
          <Drawer.Description className="sr-only">
            Дополнительные разделы и настройки
          </Drawer.Description>

          {/* Section list */}
          <nav className="flex-1 overflow-y-auto p-2" aria-label="Разделы">
            {SECTIONS.map(({ id, icon: Icon, label }) => {
              const isActive = activeSection === id;
              const showAlert = id === "system" && systemAlerts;
              return (
                <button
                  key={id}
                  onClick={() => handleSectionClick(id)}
                  className={`relative w-full flex items-center gap-3 px-3 h-11 rounded-lg transition-colors cursor-pointer ${
                    isActive
                      ? "bg-accent-muted text-accent-fg"
                      : "text-foreground hover:bg-surface-hover"
                  }`}
                  aria-label={label}
                  aria-current={isActive ? "page" : undefined}
                >
                  <Icon className="w-5 h-5 flex-shrink-0" />
                  <span className="text-sm">{label}</span>
                  {showAlert && (
                    <span className="ml-auto w-2 h-2 bg-danger rounded-full" />
                  )}
                </button>
              );
            })}
          </nav>

          {/* Footer: theme / hotkeys / logout */}
          <div className="border-t border-border p-2 flex flex-col gap-1">
            <button
              onClick={toggleTheme}
              className="w-full flex items-center gap-3 px-3 h-11 rounded-lg text-foreground hover:bg-surface-hover transition-colors cursor-pointer"
              aria-label={theme === "dark" ? "Ретро тема" : "Тёмная тема"}
            >
              {theme === "dark" ? (
                <Sun className="w-5 h-5 flex-shrink-0" />
              ) : (
                <Moon className="w-5 h-5 flex-shrink-0" />
              )}
              <span className="text-sm">
                {theme === "dark" ? "Ретро тема" : "Тёмная тема"}
              </span>
            </button>
            <button
              onClick={() => openOverlay("history")}
              className="w-full flex items-center gap-3 px-3 h-11 rounded-lg text-foreground hover:bg-surface-hover transition-colors cursor-pointer"
              aria-label="Полная история"
            >
              <ScrollText className="w-5 h-5 flex-shrink-0" />
              <span className="text-sm">Полная история</span>
            </button>
            <button
              onClick={() => openOverlay("hotkeys")}
              className="w-full flex items-center gap-3 px-3 h-11 rounded-lg text-foreground hover:bg-surface-hover transition-colors cursor-pointer"
              aria-label="Горячие клавиши"
            >
              <Keyboard className="w-5 h-5 flex-shrink-0" />
              <span className="text-sm">Горячие клавиши</span>
            </button>
            <button
              onClick={() => {
                closeOverlay();
                onLogout();
              }}
              className="w-full flex items-center gap-3 px-3 h-11 rounded-lg text-foreground hover:text-danger hover:bg-surface-hover transition-colors cursor-pointer"
              aria-label="Выйти"
            >
              <LogOut className="w-5 h-5 flex-shrink-0" />
              <span className="text-sm">Выйти</span>
            </button>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
