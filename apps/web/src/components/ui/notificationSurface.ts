// FILE: notificationSurface.ts
// Purpose: Shared visual tokens for transient and inline notification surfaces.
// Layer: UI styling helper
// Exports: notification surface class names used by toast and status banners.

// Transient app alerts are intentionally neutral. Semantic color belongs to the
// icon and a restrained edge cue, not to a blue/colored card behind every message.
const NOTIFICATION_FOREGROUND_CLASS_NAME =
  "text-[var(--notification-fg)] [--notification-fg:var(--color-text-foreground)]";

// `[-webkit-app-region:no-drag]` keeps the card (and every control inside it,
// notably the dismiss "X") clickable in the desktop app. Toasts render at the
// top edge over Electron's draggable titlebar region; without this the OS
// captures clicks in that band for window dragging and the X stops working.
export const COMPACT_NOTIFICATION_SURFACE_CLASS_NAME = `w-max max-w-[min(calc(100vw-2rem),28rem)] rounded-xl border border-border/85 bg-popover ${NOTIFICATION_FOREGROUND_CLASS_NAME} shadow-lg/12 before:hidden [-webkit-app-region:no-drag]`;

export const EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME = `w-full rounded-xl border border-border/85 bg-popover ${NOTIFICATION_FOREGROUND_CLASS_NAME} shadow-lg/12 before:hidden [-webkit-app-region:no-drag]`;

export const NOTIFICATION_ICON_CLASS_NAME = "text-[var(--notification-fg)]/92";
