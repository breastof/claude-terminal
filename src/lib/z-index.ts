/**
 * Z-Index Scale
 *
 * Centralized z-index constants to prevent overlay conflicts.
 * All fixed/absolute positioned overlays should reference this scale.
 *
 * Layer order (low → high):
 *   BASE (0) → CONTENT (10) → STICKY (20) → SIDEBAR (30) →
 *   PANEL (40) → FLOATING (50) → MODAL (60) → POPUP (100) → NAVBAR (5000)
 *
 * Tailwind usage: reference the numeric value in comments, e.g. `z-[60] // Z.MODAL`
 *
 * @example
 *   // In a modal backdrop:
 *   className="fixed inset-0 z-[60]"  // Z.MODAL
 *
 *   // In a notification banner:
 *   className="fixed top-4 right-4 z-50"  // Z.FLOATING
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
} as const;

export type ZLayer = keyof typeof Z;
