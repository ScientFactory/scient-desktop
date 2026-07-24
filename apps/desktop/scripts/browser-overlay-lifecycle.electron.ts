// FILE: browser-overlay-lifecycle.electron.ts
// Purpose: Real-Electron regression for adopted renderer webview overlay lifetime.
// Layer: Desktop integration harness (bundled and launched by the sibling runner).

import { app, BrowserWindow, type WebContents } from "electron";
import type { ThreadId } from "@synara/contracts";

import { DesktopBrowserManager } from "../src/browserManager";

const THREAD_ID = "electron-overlay-lifecycle" as ThreadId;
const OVERLAY_HOLD_MS = 31_250;
const TEST_TIMEOUT_MS = 10_000;

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

async function main(): Promise<void> {
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
      sandbox: true,
      webviewTag: true,
    },
  });
  const manager = new DesktopBrowserManager();
  manager.setWindow(hostWindow);

  try {
    await hostWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
        <style>
          html, body { margin: 0; width: 100%; height: 100%; }
          #browser-host { width: 640px; height: 480px; }
          webview { display: flex; width: 100%; height: 100%; }
        </style>
        <div id="browser-host">
          <webview id="browser" src="about:blank" partition="persist:scient-browser"></webview>
        </div>`)}`,
    );
    const guest = await withTimeout(guestPromise, "the renderer webview");
    const guestId = guest.id;

    const opened = manager.open({ threadId: THREAD_ID });
    const tabId = opened.activeTabId;
    invariant(tabId, "The browser session did not create an active tab.");
    manager.setPanelBounds({
      threadId: THREAD_ID,
      bounds: { x: 20, y: 30, width: 640, height: 480 },
      surface: "renderer",
    });
    manager.attachWebview({ threadId: THREAD_ID, tabId, webContentsId: guestId });

    const beforeOverlay = manager.getState({ threadId: THREAD_ID });
    invariant(beforeOverlay.activeTabId === tabId, "The adopted tab was not active.");
    invariant(beforeOverlay.tabs[0]?.status === "live", "The adopted tab was not live.");

    await hostWindow.webContents.executeJavaScript(`(() => {
      const webview = document.querySelector('#browser');
      if (!(webview instanceof HTMLElement)) throw new Error('Missing browser webview');
      webview.style.visibility = 'hidden';
      webview.style.pointerEvents = 'none';
      document.querySelector('#browser-host').style.width = '700px';
    })()`);

    await new Promise((resolve) => setTimeout(resolve, OVERLAY_HOLD_MS));

    const whileOccluded = manager.getState({ threadId: THREAD_ID });
    invariant(!guest.isDestroyed(), "The adopted renderer webview was destroyed while occluded.");
    invariant(whileOccluded.activeTabId === tabId, "The active tab changed while occluded.");
    invariant(
      whileOccluded.tabs.some((tab) => tab.id === tabId && tab.status === "live"),
      "The adopted tab session was suspended while occluded.",
    );

    await hostWindow.webContents.executeJavaScript(`(() => {
      const webview = document.querySelector('#browser');
      if (!(webview instanceof HTMLElement)) throw new Error('Missing browser webview');
      webview.style.visibility = 'visible';
      webview.style.pointerEvents = 'auto';
    })()`);
    manager.setPanelBounds({
      threadId: THREAD_ID,
      bounds: { x: 24, y: 34, width: 700, height: 480 },
      surface: "renderer",
    });

    const recoveredWidth = await hostWindow.webContents.executeJavaScript(
      `document.querySelector('#browser').getBoundingClientRect().width`,
    );
    const afterOverlay = manager.getState({ threadId: THREAD_ID });
    const internals = manager as unknown as {
      runtimes: Map<string, { webContents: WebContents; ownsWebContents: boolean }>;
      suspendTimers: Map<ThreadId, ReturnType<typeof setTimeout>>;
    };
    const runtime = internals.runtimes.get(`${THREAD_ID}:${tabId}`);

    invariant(recoveredWidth === 700, `Renderer geometry recovered to ${recoveredWidth}, not 700.`);
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
        recoveredWidth,
      }),
    );
  } finally {
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
