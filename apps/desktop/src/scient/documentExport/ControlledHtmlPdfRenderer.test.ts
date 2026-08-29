import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";

import {
  controlledAssetScope,
  createControlledHtmlPdfRenderer,
  isControlledAssetUrlAllowed,
} from "./ControlledHtmlPdfRenderer.ts";

vi.mock("electron", () => ({ BrowserWindow: vi.fn() }));

const sourceUrl = "https://environment.test/api/assets/signed-token/report.html";

const artifact = {
  data: new TextEncoder().encode("%PDF-1.7\nfixture"),
  sourceUrl,
  title: "Controlled report",
  profile: "document-layout" as const,
  media: "print" as const,
  warnings: [],
  sourceSignals: {
    bodyTextLength: 120,
    imageCount: 1,
    brokenImageCount: 0,
    canvasCount: 0,
    videoCount: 0,
    iframeCount: 0,
    scrollWidth: 900,
    scrollHeight: 1_600,
  },
};

function makeWindow(options?: { readonly loadError?: Error; readonly loadingAfterLoad?: boolean }) {
  const webContentsListeners = new Map<string, (...args: unknown[]) => void>();
  const sessionListeners = new Map<string, (...args: never[]) => void>();
  let beforeRequest:
    | ((
        details: { readonly url: string },
        callback: (response: { readonly cancel?: boolean }) => void,
      ) => void)
    | null = null;
  let permissionRequest:
    | ((_contents: unknown, permission: string, callback: (allowed: boolean) => void) => void)
    | null = null;
  let permissionCheck: ((...args: never[]) => boolean) | null = null;
  let destroyed = false;
  let loading = options?.loadingAfterLoad ?? false;
  const clearCache = vi.fn(async () => undefined);
  const clearStorageData = vi.fn(async () => undefined);
  const browserSession = {
    setPermissionRequestHandler: vi.fn((handler) => {
      permissionRequest = handler;
    }),
    setPermissionCheckHandler: vi.fn((handler) => {
      permissionCheck = handler;
    }),
    webRequest: {
      onBeforeRequest: vi.fn((filterOrListener, maybeListener) => {
        beforeRequest = maybeListener === undefined ? filterOrListener : maybeListener;
      }),
    },
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      sessionListeners.set(event, listener);
    }),
    off: vi.fn((event: string) => {
      sessionListeners.delete(event);
    }),
    clearCache,
    clearStorageData,
  };
  const webContents = {
    session: browserSession,
    setWindowOpenHandler: vi.fn(),
    isLoading: vi.fn(() => loading),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      webContentsListeners.set(event, listener);
    }),
    off: vi.fn((event: string) => {
      webContentsListeners.delete(event);
    }),
  };
  const window = {
    webContents,
    loadURL: vi.fn(async () => {
      if (options?.loadError) throw options.loadError;
    }),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    isDestroyed: () => destroyed,
  };
  return {
    window,
    browserSession,
    clearCache,
    clearStorageData,
    webContentsListeners,
    sessionListeners,
    getBeforeRequest: () => beforeRequest,
    getPermissionRequest: () => permissionRequest,
    getPermissionCheck: () => permissionCheck,
    setLoading: (value: boolean) => {
      loading = value;
    },
    emitWebContents: (event: string, ...args: ReadonlyArray<unknown>) => {
      webContentsListeners.get(event)?.(...args);
    },
  };
}

describe("ControlledHtmlPdfRenderer", () => {
  it("accepts only the exact signed document capability and its sibling assets", () => {
    const scope = controlledAssetScope(sourceUrl);
    expect(scope).not.toBeNull();
    expect(isControlledAssetUrlAllowed(scope!, sourceUrl)).toBe(true);
    expect(
      isControlledAssetUrlAllowed(
        scope!,
        "https://environment.test/api/assets/signed-token/styles/report.css",
      ),
    ).toBe(true);
    expect(isControlledAssetUrlAllowed(scope!, "data:image/png;base64,AA==")).toBe(true);
    expect(isControlledAssetUrlAllowed(scope!, "https://example.com/tracker.js")).toBe(false);
    expect(
      isControlledAssetUrlAllowed(
        scope!,
        "https://environment.test/api/assets/another-token/report.css",
      ),
    ).toBe(false);
    expect(controlledAssetScope("https://example.com/report.html")).toBeNull();
    expect(controlledAssetScope("file:///workspace/report.html")).toBeNull();
  });

  it.effect("renders in a hardened hidden window, blocks remote requests, and clears state", () =>
    Effect.gen(function* () {
      const fixture = makeWindow();
      let windowOptions: Electron.BrowserWindowConstructorOptions | undefined;
      const render = createControlledHtmlPdfRenderer({
        createWindow: (options) => {
          windowOptions = options;
          return fixture.window as never;
        },
        render: () => Effect.succeed(artifact),
      });
      fixture.window.loadURL.mockImplementation(async () => {
        const request = fixture.getBeforeRequest();
        expect(request).not.toBeNull();
        let localResponse: { readonly cancel?: boolean } = {};
        request!(
          { url: "https://environment.test/api/assets/signed-token/report.css" },
          (response) => {
            localResponse = response;
          },
        );
        expect(localResponse.cancel).toBe(false);
        let remoteResponse: { readonly cancel?: boolean } = {};
        request!({ url: "https://remote.example/font.woff2" }, (response) => {
          remoteResponse = response;
        });
        expect(remoteResponse.cancel).toBe(true);

        let permissionGranted = true;
        fixture.getPermissionRequest()!(null, "geolocation", (allowed) => {
          permissionGranted = allowed;
        });
        expect(permissionGranted).toBe(false);
        expect(fixture.getPermissionCheck()!()).toBe(false);
      });

      const result = yield* render(sourceUrl);

      expect(result).toMatchObject({ title: "Controlled report", blockedRequestCount: 1 });
      expect(windowOptions).toMatchObject({
        show: false,
        width: 1_280,
        height: 900,
        webPreferences: {
          partition: "scient-next-controlled-html-pdf",
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false,
          backgroundThrottling: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
        },
      });
      expect(fixture.window.loadURL).toHaveBeenCalledWith(sourceUrl);
      expect(fixture.window.destroy).toHaveBeenCalledOnce();
      expect(fixture.clearCache).toHaveBeenCalledOnce();
      expect(fixture.clearStorageData).toHaveBeenCalledOnce();
      expect(fixture.browserSession.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null);
      expect(fixture.browserSession.setPermissionRequestHandler).toHaveBeenLastCalledWith(null);
      expect(fixture.browserSession.setPermissionCheckHandler).toHaveBeenLastCalledWith(null);
      expect(fixture.webContentsListeners.size).toBe(0);
      expect(fixture.sessionListeners.size).toBe(0);
    }),
  );

  it.effect("destroys and clears the isolated window when loading fails", () =>
    Effect.gen(function* () {
      const fixture = makeWindow({ loadError: new Error("load failed") });
      const render = createControlledHtmlPdfRenderer({
        createWindow: () => fixture.window as never,
        render: () => Effect.succeed(artifact),
      });

      const result = yield* render(sourceUrl).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      expect(fixture.window.destroy).toHaveBeenCalledOnce();
      expect(fixture.clearCache).toHaveBeenCalledOnce();
      expect(fixture.clearStorageData).toHaveBeenCalledOnce();
    }),
  );

  it.effect("waits for navigation to stop before printing", () =>
    Effect.gen(function* () {
      const fixture = makeWindow({ loadingAfterLoad: true });
      const print = vi.fn(() => Effect.succeed(artifact));
      const render = createControlledHtmlPdfRenderer({
        createWindow: () => fixture.window as never,
        render: print,
      });

      const result = yield* render(sourceUrl).pipe(Effect.forkChild);
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(fixture.window.loadURL).toHaveBeenCalledOnce()),
      );
      expect(print).not.toHaveBeenCalled();

      fixture.setLoading(false);
      fixture.emitWebContents("did-stop-loading");

      expect(yield* Fiber.join(result)).toMatchObject({ title: "Controlled report" });
      expect(print).toHaveBeenCalledOnce();
      expect(fixture.webContentsListeners.size).toBe(0);
    }),
  );
});
