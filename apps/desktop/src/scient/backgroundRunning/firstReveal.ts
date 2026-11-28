// SCIENT-OWNED: app windows created while Scient runs with no window, until their first reveal.
// DesktopWindow shows them once their page is ready and counts the return; showing one earlier
// gives a blank window that analytics would not count.
import type * as Electron from "electron";

const awaitingFirstReveal = new WeakSet<Electron.BrowserWindow>();

export function markAwaitingFirstReveal(window: Electron.BrowserWindow): void {
  awaitingFirstReveal.add(window);
}

export function clearAwaitingFirstReveal(window: Electron.BrowserWindow): void {
  awaitingFirstReveal.delete(window);
}

export function isAwaitingFirstReveal(window: Electron.BrowserWindow): boolean {
  return awaitingFirstReveal.has(window);
}
