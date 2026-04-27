/**
 * Z-Index Scale
 *
 * Centralized z-index constants to prevent overlay conflicts.
 * All fixed/absolute positioned overlays should reference this scale.
 *
 * Layer order (low → high):
 *   BASE (0) → CONTENT (10) → STICKY (20) → SIDEBAR (30) →
 *   PANEL (40) → FLOATING (50) → MODAL (60) → POPUP (100) →
 *   NAVBAR (5000) → PALETTE (9000) → TOAST (9500)
 *
 * Tailwind usage: utility classes `z-base`, `z-content`, `z-sticky`,
 * `z-sidebar`, `z-panel`, `z-floating`, `z-modal`, `z-popup`, `z-palette`,
 * `z-toast`, `z-navbar` are generated from CSS vars in `globals.css`
 * (`@theme inline { --z-* }`). Inline-style consumers can keep using
 * `style={{ zIndex: Z.MODAL }}`.
 *
 * @example
 *   // In a modal backdrop:
 *   className="fixed inset-0 z-modal"
 *
 *   // In a notification banner:
 *   className="fixed top-4 right-4 z-floating"
 */
export const Z = {
  /** Default stacking context */
  BASE: 0,
  /** In-page content overlays: badges, toggle buttons, loading states */
  CONTENT: 10,
  /** Sticky elements: status badges, inline warnings */
  STICKY: 20,
  /** Mobile sidebar backdrops */
  SIDEBAR: 30,
  /** Slide-out panels: admin panel, chat panel (mobile) */
  PANEL: 40,
  /** Floating elements: dropdowns, popups, banners, alerts, notifications */
  FLOATING: 50,
  /** Modal dialogs: confirmations, wizards, config modals */
  MODAL: 60,
  /** Top-layer popups: context menus, lightbox */
  POPUP: 100,
  /** Floating navbar — always on top */
  NAVBAR: 5000,
  /** Command palette (Cmd+K) — above modals, below toasts */
  PALETTE: 9000,
  /** Toast notifications — top of stack */
  TOAST: 9500,
} as const;

export type ZLayer = keyof typeof Z;
