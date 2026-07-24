// FILE: browser-overlay-lifecycle.electron.ts
// Purpose: Real-Electron regression for adopted renderer webview overlay lifetime.
// Layer: Desktop integration harness (bundled and launched by the sibling runner).

import { join } from "node:path";

import type { ThreadId } from "@synara/contracts";
import { app, BrowserWindow, ipcMain, type WebContents } from "electron";

import { DesktopBrowserManager } from "../src/browserManager";

const THREAD_ID = "electron-overlay-lifecycle" as ThreadId;
const OVERLAY_HOLD_MS = 31_250;
const TEST_TIMEOUT_MS = 10_000;
const BOUNDS_CHANNEL = "scient:test:browser-overlay:set-bounds";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), TEST_TIMEOUT_MS);
    }),
  ]);
}

async function waitForRendererHarness(hostWindow: BrowserWindow): Promise<void> {
  await withTimeout(
    (async () => {
      while (!hostWindow.isDestroyed()) {
        const ready = await hostWindow.webContents.executeJavaScript(
          `Boolean(window.scientBrowserOverlayLifecycle?.ready)`,
        );
        if (ready) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("The host window was destroyed before its renderer harness loaded.");
    })(),
    "the renderer coordination harness",
  );
}

async function main(): Promise<void> {
  const profileDir = process.env.SCIENT_BROWSER_OVERLAY_TEST_PROFILE;
  const fixturePath = process.env.SCIENT_BROWSER_OVERLAY_TEST_FIXTURE;
  const preloadPath = process.env.SCIENT_BROWSER_OVERLAY_TEST_PRELOAD;
  invariant(profileDir, "Missing isolated Electron profile path.");
  invariant(fixturePath, "Missing renderer fixture path.");
  invariant(preloadPath, "Missing preload fixture path.");
  app.setPath("userData", profileDir);
  app.setPath("sessionData", join(profileDir, "session-data"));

  await app.whenReady();

  let resolveGuest: ((webContents: WebContents) => void) | null = null;
  const guestPromise = new Promise<WebContents>((resolve) => {
    resolveGuest = resolve;
  });
  app.on("web-contents-created", (_event, webContents) => {
    if (webContents.getType() === "webview") {
      resolveGuest?.(webContents);
      resolveGuest = null;
    }
  });

  const hostWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: true,
      webviewTag: true,
    },
  });
  const manager = new DesktopBrowserManager();
  manager.setWindow(hostWindow);
  const boundsEvents: Array<{ width: number; height: number } | null> = [];
  ipcMain.handle(BOUNDS_CHANNEL, (_event, bounds: { width: number; height: number } | null) => {
    boundsEvents.push(bounds);
    manager.setPanelBounds({
      threadId: THREAD_ID,
      bounds: bounds ? { x: 20, y: 30, width: bounds.width, height: bounds.height } : null,
      surface: "renderer",
    });
  });

  try {
    await hostWindow.loadFile(fixturePath);
    await waitForRendererHarness(hostWindow);
    const guest = await withTimeout(guestPromise, "the renderer webview");
    const guestId = guest.id;

    const opened = manager.open({ threadId: THREAD_ID });
    const tabId = opened.activeTabId;
    invariant(tabId, "The browser session did not create an active tab.");
    manager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: guestId });
    const initialMode = await hostWindow.webContents.executeJavaScript(
      `window.scientBrowserOverlayLifecycle.syncBounds()`,
    );
    invariant(initialMode === "send", `Initial renderer bounds mode was ${String(initialMode)}.`);

    const beforeOverlay = manager.getState({ threadId: THREAD_ID });
    invariant(beforeOverlay.activeTabId === tabId, "The adopted tab was not active.");
    invariant(beforeOverlay.tabs[0]?.status === "live", "The adopted tab was not live.");
    const boundsEventsBeforeOverlay = boundsEvents.length;

    const openMode = await hostWindow.webContents.executeJavaScript(
      `window.scientBrowserOverlayLifecycle.openOverlay()`,
    );
    invariant(openMode === "suppress", `Overlay renderer bounds mode was ${String(openMode)}.`);
    invariant(
      boundsEvents.length === boundsEventsBeforeOverlay,
      "Opening the overlay sent a lifecycle-changing bounds event.",
    );

    await new Promise((resolve) => setTimeout(resolve, OVERLAY_HOLD_MS));

    const whileOccluded = manager.getState({ threadId: THREAD_ID });
    invariant(!guest.isDestroyed(), "The adopted renderer webview was destroyed while occluded.");
    invariant(whileOccluded.activeTabId === tabId, "The active tab changed while occluded.");
    invariant(
      whileOccluded.tabs.some((tab) => tab.id === tabId && tab.status === "live"),
      "The adopted tab session was suspended while occluded.",
    );
    invariant(
      !boundsEvents.slice(boundsEventsBeforeOverlay).includes(null),
      "Overlay occlusion sent null bounds and started the hide lifecycle.",
    );

    const closeMode = await hostWindow.webContents.executeJavaScript(
      `window.scientBrowserOverlayLifecycle.closeOverlay()`,
    );
    invariant(closeMode === "send", `Recovered renderer bounds mode was ${String(closeMode)}.`);

    const recoveredWidth = await hostWindow.webContents.executeJavaScript(
      `document.querySelector('#browser-host').getBoundingClientRect().width`,
    );
    const afterOverlay = manager.getState({ threadId: THREAD_ID });
    const internals = manager as unknown as {
      runtimes: Map<string, { webContents: WebContents; ownsWebContents: boolean }>;
      suspendTimers: Map<ThreadId, ReturnType<typeof setTimeout>>;
    };
    const runtime = internals.runtimes.get(`${THREAD_ID}:${tabId}`);

    invariant(recoveredWidth === 700, `Renderer geometry recovered to ${recoveredWidth}, not 700.`);
    invariant(
      boundsEvents.at(-1)?.width === 700,
      "The renderer did not send recovered geometry after the overlay closed.",
    );
    invariant(
      runtime?.webContents.id === guestId,
      "A different runtime replaced the adopted webview.",
    );
    invariant(runtime.ownsWebContents === false, "The adopted renderer runtime changed ownership.");
    invariant(internals.suspendTimers.size === 0, "Overlay occlusion scheduled a thread suspend.");
    invariant(
      afterOverlay.activeTabId === tabId,
      "The tab session did not recover after occlusion.",
    );

    console.log(
      JSON.stringify({
        result: "passed",
        heldOccludedMs: OVERLAY_HOLD_MS,
        adoptedWebContentsId: guestId,
        activeTabId: tabId,
        openMode,
        closeMode,
        recoveredWidth,
      }),
    );
  } finally {
    ipcMain.removeHandler(BOUNDS_CHANNEL);
    manager.dispose();
    if (!hostWindow.isDestroyed()) {
      hostWindow.destroy();
    }
  }
}

void main().then(
  () => app.quit(),
  (error) => {
    console.error(error instanceof Error ? error.stack : error);
    app.exit(1);
  },
);
