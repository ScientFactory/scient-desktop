// FILE: browser-overlay-lifecycle.preload.ts
// Purpose: Minimal isolated bridge for the Electron overlay lifecycle regression.

import { contextBridge, ipcRenderer } from "electron";

const BOUNDS_CHANNEL = "scient:test:browser-overlay:set-bounds";

contextBridge.exposeInMainWorld("scientBrowserOverlayTestApi", {
  setPanelBounds: (bounds: { width: number; height: number } | null) =>
    ipcRenderer.invoke(BOUNDS_CHANNEL, bounds),
});
