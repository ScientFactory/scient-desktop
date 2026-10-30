import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

const threadRef = scopeThreadRef("env 1" as EnvironmentId, ThreadId.make("thread#1"));
const APP_URL = "app://-/index.html";

function sharedLocalStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

async function openAppWindow(storage: ReturnType<typeof sharedLocalStorage>, route: string) {
  const openNewWindow = vi.fn((_route: string, _options?: { readonly atCursor?: boolean }) =>
    Promise.resolve(true),
  );
  const replaceState = vi.fn((_state: unknown, _unused: string, _url: string) => undefined);
  const appWindow = Object.assign(new EventTarget(), {
    localStorage: storage,
    location: { href: `${APP_URL}#${route}`, hash: `#${route}` },
    history: { state: null, replaceState },
    desktopBridge: { openNewWindow },
  });
  vi.resetModules();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", appWindow);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  const [{ useRightPanelStore }, panelTabWindow, previewHost] = await Promise.all([
    import("../../rightPanelStore"),
    import("./panelTabWindow"),
    import("./previewHostOwnership"),
  ]);
  return {
    window: appWindow,
    openNewWindow,
    replaceState,
    store: useRightPanelStore,
    panel: () => useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)],
    ...panelTabWindow,
    ...previewHost,
  };
}

describe("a side panel tab opened in a new window", () => {
  it("opens the window on the same route and shows the tab there, maximized", async () => {
    const storage = sharedLocalStorage();
    const opener = await openAppWindow(storage, "/env%201/thread%231?diff=1");
    opener.store.getState().open(threadRef, "diff");
    opener.store.getState().openBrowser(threadRef, "tab-1");
    opener.store.getState().activateSurface(threadRef, "diff");

    opener.openPanelTabInNewWindow({ threadRef, surfaceId: "browser:tab-1", atCursor: true });
    const [route, options] = opener.openNewWindow.mock.calls[0]!;
    expect(options).toEqual({ atCursor: true });

    const opened = await openAppWindow(storage, route);
    opened.applyPanelTabWindowRequest(opened.window);

    expect(opened.replaceState).toHaveBeenCalledExactlyOnceWith(
      null,
      "",
      `${APP_URL}#/env%201/thread%231?diff=1`,
    );
    expect(opened.panel()).toMatchObject({
      isOpen: true,
      activeSurfaceId: "browser:tab-1",
      maximized: true,
    });
    expect(opened.consumePreviewTakeover("tab-1")).toBe(true);
    expect(opened.consumePreviewTakeover("tab-1")).toBe(false);
  });

  it("only clears the request when the tab has closed meanwhile", async () => {
    const storage = sharedLocalStorage();
    const opener = await openAppWindow(storage, "/env%201/thread%231");
    opener.store.getState().open(threadRef, "diff");
    opener.store.getState().openBrowser(threadRef, "tab-1");
    opener.openPanelTabInNewWindow({ threadRef, surfaceId: "browser:tab-1" });
    const [route, options] = opener.openNewWindow.mock.calls[0]!;
    expect(options).toBeUndefined();
    opener.store.getState().closeSurface(threadRef, "browser:tab-1");

    const opened = await openAppWindow(storage, route);
    opened.applyPanelTabWindowRequest(opened.window);

    expect(opened.replaceState).toHaveBeenCalledExactlyOnceWith(
      null,
      "",
      `${APP_URL}#/env%201/thread%231`,
    );
    expect(opened.panel()).toMatchObject({ activeSurfaceId: "diff" });
    expect(opened.panel()?.maximized).toBeUndefined();
    expect(opened.consumePreviewTakeover("tab-1")).toBe(false);
  });
});
