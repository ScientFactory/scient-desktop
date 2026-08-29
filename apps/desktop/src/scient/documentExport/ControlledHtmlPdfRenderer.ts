import type {
  DesktopControlledHtmlPdfRenderArtifact,
  DesktopPreviewPdfExportArtifact,
} from "@t3tools/contracts";
import { BrowserWindow, type BrowserWindowConstructorOptions, type WebContents } from "electron";
import * as Effect from "effect/Effect";

const CONTROLLED_RENDER_PARTITION = "scient-next-controlled-html-pdf";
const CONTROLLED_RENDER_TIMEOUT_MS = 60_000;

export interface ControlledHtmlPdfRendererError {
  readonly _tag: "ControlledHtmlPdfRendererError";
  readonly operation: string;
  readonly cause?: unknown;
}

interface ControlledRenderWindow {
  readonly loadURL: (url: string) => Promise<unknown>;
  readonly destroy: () => void;
  readonly isDestroyed: () => boolean;
  readonly webContents: WebContents;
}

export interface ControlledHtmlPdfRendererOptions {
  readonly createWindow?: (options: BrowserWindowConstructorOptions) => ControlledRenderWindow;
  readonly render: (
    webContents: WebContents,
  ) => Effect.Effect<
    DesktopPreviewPdfExportArtifact,
    { readonly _tag?: string; readonly cause?: unknown }
  >;
  readonly timeoutMs?: number;
}

interface ControlledAssetScope {
  readonly sourceUrl: string;
  readonly assetPrefix: string;
  readonly sourceOrigin: string;
}

export function controlledAssetScope(sourceUrl: string): ControlledAssetScope | null {
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const segments = parsed.pathname.split("/");
    const assetsIndex = segments.findIndex(
      (segment, index) => segment === "assets" && segments[index - 1] === "api",
    );
    if (assetsIndex < 0 || !segments[assetsIndex + 1] || !segments[assetsIndex + 2]) return null;
    parsed.hash = "";
    const normalizedSourceUrl = parsed.toString();
    const prefixUrl = new URL(normalizedSourceUrl);
    prefixUrl.pathname = `${segments.slice(0, assetsIndex + 2).join("/")}/`;
    prefixUrl.search = "";
    prefixUrl.hash = "";
    return {
      sourceUrl: normalizedSourceUrl,
      assetPrefix: prefixUrl.toString(),
      sourceOrigin: parsed.origin,
    };
  } catch {
    return null;
  }
}

export function isControlledAssetUrlAllowed(scope: ControlledAssetScope, rawUrl: string): boolean {
  if (rawUrl === "about:blank") return true;
  try {
    const candidate = new URL(rawUrl);
    if (candidate.protocol === "data:" || candidate.protocol === "blob:") return true;
    if (candidate.origin !== scope.sourceOrigin) return false;
    candidate.hash = "";
    const normalized = candidate.toString();
    return normalized === scope.sourceUrl || normalized.startsWith(scope.assetPrefix);
  } catch {
    return false;
  }
}

const rendererError = (operation: string, cause?: unknown): ControlledHtmlPdfRendererError => ({
  _tag: "ControlledHtmlPdfRendererError",
  operation,
  ...(cause === undefined ? {} : { cause }),
});

const waitForLoadSettlement = (
  webContents: WebContents,
): Effect.Effect<void, ControlledHtmlPdfRendererError> => {
  if (!webContents.isLoading()) return Effect.void;

  return Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          webContents.off("did-stop-loading", onDidStopLoading);
          webContents.off("did-fail-load", onDidFailLoad);
          webContents.off("destroyed", onDestroyed);
          signal.removeEventListener("abort", onAbort);
        };
        const succeed = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const fail = (cause: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(cause);
        };
        const onDidStopLoading = () => succeed();
        const onDidFailLoad = (
          _event: Electron.Event,
          errorCode: number,
          errorDescription: string,
          validatedUrl: string,
          isMainFrame: boolean,
        ) => {
          if (!isMainFrame) return;
          fail(
            new Error(
              `Controlled HTML navigation failed (${errorCode}: ${errorDescription}) for ${validatedUrl}.`,
            ),
          );
        };
        const onDestroyed = () => fail(new Error("Controlled HTML render window was destroyed."));
        const onAbort = () =>
          fail(signal.reason ?? new Error("Controlled HTML rendering stopped."));

        webContents.on("did-stop-loading", onDidStopLoading);
        webContents.on("did-fail-load", onDidFailLoad);
        webContents.on("destroyed", onDestroyed);
        signal.addEventListener("abort", onAbort, { once: true });

        // Loading may have stopped between the first check and listener setup.
        if (!webContents.isLoading()) succeed();
      }),
    catch: (cause) => rendererError("renderHtmlPdf.settle", cause),
  });
};

export function createControlledHtmlPdfRenderer(options: ControlledHtmlPdfRendererOptions) {
  const createWindow =
    options.createWindow ??
    ((windowOptions: BrowserWindowConstructorOptions) => new BrowserWindow(windowOptions));
  const timeoutMs = options.timeoutMs ?? CONTROLLED_RENDER_TIMEOUT_MS;

  return (
    sourceUrl: string,
  ): Effect.Effect<DesktopControlledHtmlPdfRenderArtifact, ControlledHtmlPdfRendererError> => {
    const scope = controlledAssetScope(sourceUrl);
    if (!scope) {
      return Effect.fail(
        rendererError(
          "renderHtmlPdf.validateSourceUrl",
          new Error("Only a signed Scient HTML asset URL can be rendered."),
        ),
      );
    }

    return Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const window = createWindow({
            show: false,
            width: 1_280,
            height: 900,
            backgroundColor: "#ffffff",
            webPreferences: {
              partition: CONTROLLED_RENDER_PARTITION,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              webviewTag: false,
              backgroundThrottling: false,
              navigateOnDragDrop: false,
              safeDialogs: true,
              spellcheck: false,
              webSecurity: true,
              allowRunningInsecureContent: false,
            },
          });
          const browserSession = window.webContents.session;
          const blockedRequests = { count: 0 };
          const blockEscapingRequest = (
            details: Electron.OnBeforeRequestListenerDetails,
            callback: (response: Electron.CallbackResponse) => void,
          ) => {
            const allowed = isControlledAssetUrlAllowed(scope, details.url);
            if (!allowed) blockedRequests.count += 1;
            callback({ cancel: !allowed });
          };
          const preventNavigation = (event: Electron.Event, url: string) => {
            if (!isControlledAssetUrlAllowed(scope, url) || url !== scope.sourceUrl) {
              blockedRequests.count += 1;
              event.preventDefault();
            }
          };
          const preventWebview = (event: Electron.Event) => event.preventDefault();
          const preventDownload = (event: Electron.Event) => event.preventDefault();

          browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
            callback(false);
          });
          browserSession.setPermissionCheckHandler(() => false);
          browserSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, blockEscapingRequest);
          browserSession.on("will-download", preventDownload);
          window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
          window.webContents.on("will-navigate", preventNavigation);
          window.webContents.on("will-redirect", preventNavigation);
          window.webContents.on("will-attach-webview", preventWebview);

          return {
            window,
            blockedRequests,
            cleanup: async () => {
              window.webContents.off("will-navigate", preventNavigation);
              window.webContents.off("will-redirect", preventNavigation);
              window.webContents.off("will-attach-webview", preventWebview);
              browserSession.off("will-download", preventDownload);
              browserSession.webRequest.onBeforeRequest(null);
              browserSession.setPermissionRequestHandler(null);
              browserSession.setPermissionCheckHandler(null);
              if (!window.isDestroyed()) window.destroy();
              await Promise.allSettled([
                browserSession.clearCache(),
                browserSession.clearStorageData(),
              ]);
            },
          };
        },
        catch: (cause) => rendererError("renderHtmlPdf.createWindow", cause),
      }),
      ({ window, blockedRequests }) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => window.loadURL(scope.sourceUrl),
            catch: (cause) => rendererError("renderHtmlPdf.load", cause),
          });
          yield* waitForLoadSettlement(window.webContents);
          const artifact = yield* options
            .render(window.webContents)
            .pipe(Effect.mapError((cause) => rendererError("renderHtmlPdf.print", cause)));
          return {
            ...artifact,
            blockedRequestCount: blockedRequests.count,
          };
        }).pipe(
          Effect.timeout(timeoutMs),
          Effect.mapError((cause) =>
            cause._tag === "TimeoutError"
              ? rendererError(
                  "renderHtmlPdf.timeout",
                  new Error(`Controlled HTML rendering exceeded ${timeoutMs} ms.`),
                )
              : cause,
          ),
        ),
      ({ cleanup }) =>
        Effect.tryPromise({
          try: cleanup,
          catch: (cause) => rendererError("renderHtmlPdf.cleanup", cause),
        }).pipe(Effect.catch(() => Effect.void)),
    );
  };
}
