// FILE: browser-overlay-lifecycle.renderer.ts
// Purpose: Exercise the production overlay classifier and bounds decision in a real renderer.

import {
  hasNativeBrowserObscuringOverlay,
  resolveNativeBrowserBoundsSyncMode,
  setBrowserWebviewOverlayOcclusion,
  type BrowserWebviewElement,
} from "../../web/src/components/BrowserPanel.overlay";

declare global {
  interface Window {
    scientBrowserOverlayTestApi: {
      setPanelBounds(bounds: { width: number; height: number } | null): Promise<void>;
    };
    scientBrowserOverlayLifecycle: {
      ready: true;
      syncBounds(): Promise<string>;
      openOverlay(): Promise<string>;
      closeOverlay(): Promise<string>;
    };
  }
}

const host = document.querySelector<HTMLElement>("#browser-host");
const webview = document.querySelector<BrowserWebviewElement>("#browser");
if (!host || !webview) {
  throw new Error("Missing browser overlay lifecycle fixture elements.");
}

async function syncBounds(): Promise<string> {
  const obscuredByOverlay = hasNativeBrowserObscuringOverlay(host);
  setBrowserWebviewOverlayOcclusion(webview, obscuredByOverlay);
  const rect = host.getBoundingClientRect();
  const mode = resolveNativeBrowserBoundsSyncMode({
    obscuredByOverlay,
    paneIsActuallyHidden: rect.width <= 0 || rect.height <= 0,
  });
  if (mode === "suppress") {
    return mode;
  }
  await window.scientBrowserOverlayTestApi.setPanelBounds(
    mode === "hide" ? null : { width: rect.width, height: rect.height },
  );
  return mode;
}

window.scientBrowserOverlayLifecycle = {
  ready: true,
  syncBounds,
  async openOverlay() {
    const overlay = document.createElement("div");
    overlay.id = "test-overlay";
    overlay.dataset.nativeBrowserOverlay = "true";
    document.body.append(overlay);
    host.style.width = "700px";
    return syncBounds();
  },
  async closeOverlay() {
    document.querySelector("#test-overlay")?.remove();
    return syncBounds();
  },
};
