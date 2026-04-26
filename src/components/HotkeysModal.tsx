"use client";

import { useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Drawer } from "vaul";
import { useOS, type OS } from "@/lib/useOS";
import { useIsMobile } from "@/lib/useIsMobile";
import { useOverlay, useOverlayStore } from "@/lib/overlayStore";
import ModalTitleBar from "@/components/ModalTitleBar";

// ─── Data ────────────────────────────────────────────────────────────────────

interface Hotkey {
  description: string;
  mac: string[];
  win: string[];
  note?: string;
}

interface HotkeyGroup {
  title: string;
  hotkeys: Hotkey[];
}

const HOTKEY_GROUPS: HotkeyGroup[] = [
  {
    title: "Терминал",
    hotkeys: [
      {
        description: "Копировать",
        mac: ["⌘", "C"],
        win: ["Ctrl", "C"],
        note: "Win/Linux: при выделенном тексте",
      },
      {
        description: "Копировать (альтернатива)",
        mac: ["⌘", "C"],
        win: ["Ctrl", "Shift", "C"],
      },
      {
        description: "Вставить",
        mac: ["⌘", "V"],
        win: ["Ctrl", "V"],
      },
      {
        description: "Вставить (альтернатива)",
        mac: ["⌘", "V"],
        win: ["Ctrl", "Shift", "V"],
      },
      {
        description: "Прервать процесс (SIGINT)",
        mac: ["⌃", "C"],
        win: ["Ctrl", "C"],
        note: "Win/Linux: без выделения",
      },
      {
        description: "Очистить экран",
        mac: ["⌘", "K"],
        win: ["Ctrl", "L"],
      },
    ],
  },
  {
    title: "Навигация",
    hotkeys: [
      {
        description: "Прокрутка вверх",
        mac: ["⇧", "Page Up"],
        win: ["Shift", "Page Up"],
      },
      {
        description: "Прокрутка вниз",
        mac: ["⇧", "Page Down"],
        win: ["Shift", "Page Down"],
      },
      {
        description: "В начало буфера",
        mac: ["⌘", "Home"],
        win: ["Ctrl", "Home"],
      },
      {
        description: "В конец буфера",
        mac: ["⌘", "End"],
        win: ["Ctrl", "End"],
      },
    ],
  },
  {
    title: "Интерфейс",
    hotkeys: [
      {
        description: "Выход из полноэкранного режима",
        mac: ["Esc"],
        win: ["Esc"],
      },
    ],
  },
  {
    title: "Редактор",
    hotkeys: [
      {
        description: "Сохранить файл",
        mac: ["⌘", "S"],
        win: ["Ctrl", "S"],
      },
      {
        description: "Закрыть вкладку",
        mac: ["⌥", "W"],
        win: ["Alt", "W"],
      },
      {
        description: "Превью (toggle)",
        mac: ["⌘", "⇧", "V"],
        win: ["Ctrl", "Shift", "V"],
      },
      {
        description: "Поиск в файле",
        mac: ["⌘", "F"],
        win: ["Ctrl", "F"],
      },
      {
        description: "Замена в файле",
        mac: ["⌘", "H"],
        win: ["Ctrl", "H"],
      },
      {
        description: "Отменить",
        mac: ["⌘", "Z"],
        win: ["Ctrl", "Z"],
      },
      {
        description: "Повторить",
        mac: ["⌘", "⇧", "Z"],
        win: ["Ctrl", "Shift", "Z"],
      },
    ],
  },
  {
    title: "Чат",
    hotkeys: [
      {
        description: "Отправить сообщение",
        mac: ["Enter"],
        win: ["Enter"],
      },
      {
        description: "Новая строка в сообщении",
        mac: ["⇧", "Enter"],
        win: ["Shift", "Enter"],
      },
      {
        description: "Открыть чат курсора",
        mac: ["/"],
        win: ["/"],
      },
    ],
  },
];

// ─── Sub-components ──────────────────────────────────────────────────────────

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[28px] h-[26px] px-1.5 rounded-[6px] text-[11px] font-mono font-medium bg-surface-hover border border-border text-foreground/70 shadow-[0_1px_0_1px_var(--th-border)]">
      {children}
    </kbd>
  );
}

function KeyCombo({ keys }: { keys: string[] }) {
  return (
    <div className="flex items-center gap-[3px]">
      {keys.map((key, i) => (
        <KeyCap key={i}>{key}</KeyCap>
      ))}
    </div>
  );
}

function HotkeyRow({ hotkey, os }: { hotkey: Hotkey; os: OS }) {
  const keys = os === "mac" ? hotkey.mac : hotkey.win;

  return (
    <div className="flex items-center justify-between py-2 px-4 gap-4">
      <div className="flex flex-col min-w-0">
        <span className="text-xs text-foreground truncate">
          {hotkey.description}
        </span>
        {hotkey.note && (
          <span className="text-[10px] text-muted-fg mt-0.5">
            {hotkey.note}
          </span>
        )}
      </div>
      <KeyCombo keys={keys} />
    </div>
  );
}

function HotkeysBody({ os }: { os: OS }) {
  return (
    <>
      {/* Content */}
      <div className="flex-1 overflow-y-auto py-2">
        {HOTKEY_GROUPS.map((group, gi) => (
          <div key={gi}>
            {gi > 0 && <div className="h-px bg-border mx-4 my-1" />}
            <div className="px-4 pt-3 pb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-fg">
                {group.title}
              </span>
            </div>
            {group.hotkeys.map((hk, hi) => (
              <HotkeyRow key={hi} hotkey={hk} os={os} />
            ))}
          </div>
        ))}
      </div>

      {/* Footer hint */}
      <div className="border-t border-border px-4 py-2.5 text-center shrink-0">
        <span className="text-[10px] text-muted">
          {os === "mac" ? "macOS" : os === "windows" ? "Windows" : "Linux"}{" "}
          — раскладка определена автоматически
        </span>
      </div>
    </>
  );
}

// ─── Main modal ──────────────────────────────────────────────────────────────

/**
 * HotkeysModal — driven by `overlayStore` slot `"hotkeys"` (AS-SHIPPED short
 * name; plan §2.3 long name was `"hotkeysModal"`). Mobile path renders a vaul
 * bottom sheet; desktop path keeps the existing motion-based modal but with
 * `max-h-[80dvh]` instead of `vh` so iOS keyboards don't crop it.
 *
 * Per `06-integration-plan-mobile.md §3.17`. Mount lives at page-level once
 * (`dashboard/page.tsx`), no props consumed.
 */
export default function HotkeysModal() {
  const os = useOS();
  const isMobile = useIsMobile();
  const open = useOverlay("hotkeys");
  const closeOverlay = useOverlayStore((s) => s.closeOverlay);

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") closeOverlay();
    },
    [closeOverlay]
  );

  // Global Esc — vaul/Radix wires its own Esc on mobile; this handles desktop
  // and is a no-op duplicate on mobile (vaul already closes via overlayStore).
  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open, handleEscape]);

  if (isMobile) {
    return (
      <Drawer.Root
        open={open}
        onOpenChange={(o) => {
          if (!o) closeOverlay();
        }}
        dismissible
      >
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 bg-black/60 z-modal" />
          <Drawer.Content
            aria-label="Горячие клавиши"
            className="fixed inset-x-0 bottom-0 z-modal max-h-[90dvh] bg-surface rounded-t-2xl flex flex-col pb-safe outline-none"
          >
            <div className="mx-auto h-1.5 w-12 my-2 rounded-full bg-border flex-shrink-0" />
            <Drawer.Title className="sr-only">Горячие клавиши</Drawer.Title>
            <Drawer.Description className="sr-only">
              Список горячих клавиш приложения
            </Drawer.Description>
            <ModalTitleBar title="Горячие клавиши" onClose={closeOverlay} />
            <HotkeysBody os={os} />
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  // Desktop: keep the existing motion-based modal
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 z-modal flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Горячие клавиши"
          onClick={closeOverlay}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="bg-surface border border-border-strong rounded-[var(--th-radius)] overflow-hidden max-w-md w-full max-h-[80dvh] flex flex-col"
            style={{
              boxShadow:
                "var(--th-shadow, 0 0 0 transparent), 0 25px 50px -12px rgba(0,0,0,0.5)",
            }}
          >
            {/* Title bar */}
            <ModalTitleBar title="Горячие клавиши" onClose={closeOverlay} />
            <HotkeysBody os={os} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
