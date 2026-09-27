// @effect-diagnostics nodeBuiltinImport:off -- The document page is served from the packaged client files.
import {
  SCIENT_DOCUMENT_CAPTURE_INPUT_FILE,
  SCIENT_DOCUMENT_PAGE_INPUT_PARAMETER,
  SCIENT_DOCUMENT_PAGE_PATH,
  SCIENT_DOCUMENT_PAGE_READINESS_GLOBAL,
  ScientDocumentPageReadiness,
  scientDocumentReadinessRejection,
  type DesktopDocumentPageRenderInput,
  type DesktopDocumentPageRenderOutcome,
  type DesktopPreviewPdfExportArtifact,
} from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";
import type { BrowserWindowConstructorOptions, Session, WebContents } from "electron";

import { createBrowserPdfRenderer, type BrowserPdfRendererError } from "./BrowserPdfRenderer.ts";
import {
  controlledAssetScope,
  isControlledAssetUrlAllowed,
  waitForLoadSettlement,
} from "./ControlledHtmlPdfRenderer.ts";

/**
 * Prints Scient's document page. The page is the web client's standalone
 * `scient-document.html` entry, served from the desktop's own app scheme into
 * a hidden window with a private, non-persistent session. That session can
 * reach only the page's own files and the one signed capture it renders; it
 * has no permissions, navigation, downloads, popups, or other network access.
 * The page must report a readiness that matches the requested capture, with
 * nothing unfinished and no fatal problem, before anything is printed.
 */

const DOCUMENT_PAGE_PARTITION = "scient-next-document-page";
const DOCUMENT_PAGE_HOST = "app";
const DOCUMENT_PAGE_TIMEOUT_MS = 90_000;
const READINESS_POLL_ATTEMPTS = 400;
const READINESS_POLL_INTERVAL_MS = 50;
const PRODUCTION_ASSET_PATH = /^\/assets\/[^/]+$/u;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

/** Where the page's own files come from: the packaged client, or Vite in development. */
export type DocumentPageFiles =
  | { readonly _tag: "packaged"; readonly assetDirectory: string }
  | { readonly _tag: "development"; readonly targetOrigin: URL };

export interface DocumentPageSource {
  readonly scheme: string;
  readonly files: DocumentPageFiles;
}

export const documentPageOrigin = (scheme: string) => `${scheme}://${DOCUMENT_PAGE_HOST}`;

export function documentPageUrl(scheme: string, inputUrl: string): string {
  const url = new URL(SCIENT_DOCUMENT_PAGE_PATH, documentPageOrigin(scheme));
  url.hash = new URLSearchParams({ [SCIENT_DOCUMENT_PAGE_INPUT_PARAMETER]: inputUrl }).toString();
  return url.toString();
}

export function documentPageContentSecurityPolicy(files: DocumentPageFiles): string {
  return [
    "default-src 'none'",
    // Vite's development preamble is an inline module; packaged builds have none.
    `script-src 'self'${files._tag === "development" ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "font-src 'self' data:",
    "connect-src 'self' http: https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** Serves the page entry and its hashed build assets, nothing else, from the packaged client. */
export async function servePackagedDocumentPageFile(
  assetDirectory: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== DOCUMENT_PAGE_HOST) return new Response(null, { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (pathname !== SCIENT_DOCUMENT_PAGE_PATH && !PRODUCTION_ASSET_PATH.test(pathname)) {
    return new Response(null, { status: 404 });
  }
  const root = NodePath.resolve(assetDirectory);
  const filePath = NodePath.resolve(root, `.${pathname}`);
  if (!filePath.startsWith(`${root}${NodePath.sep}`)) return new Response(null, { status: 404 });
  const contents = await NodeFSP.readFile(filePath).catch(() => null);
  if (contents === null) return new Response(null, { status: 404 });
  return new Response(request.method === "HEAD" ? null : new Uint8Array(contents), {
    headers: {
      "content-type":
        CONTENT_TYPES[NodePath.extname(filePath).toLowerCase()] ?? "application/octet-stream",
    },
  });
}

async function serveDocumentPageFile(
  files: DocumentPageFiles,
  request: Request,
  fetchDevelopment: (url: string) => Promise<Response>,
): Promise<Response> {
  const response =
    files._tag === "packaged"
      ? await servePackagedDocumentPageFile(files.assetDirectory, request)
      : await (async () => {
          const url = new URL(request.url);
          if (request.method !== "GET" && request.method !== "HEAD") {
            return new Response(null, { status: 405 });
          }
          return fetchDevelopment(new URL(`${url.pathname}${url.search}`, files.targetOrigin).href);
        })();
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", documentPageContentSecurityPolicy(files));
  return new Response(response.body, { status: response.status, headers });
}

interface DocumentPageScope {
  readonly pageUrl: string;
  readonly pageOrigin: string;
  readonly capture: NonNullable<ReturnType<typeof controlledAssetScope>>;
}

/** Only the page's own files and the one signed capture it renders may load. */
export function isDocumentPageRequestAllowed(scope: DocumentPageScope, rawUrl: string): boolean {
  try {
    // A custom scheme has an opaque origin, so compare its scheme and host.
    const candidate = new URL(rawUrl);
    const page = new URL(scope.pageOrigin);
    if (candidate.protocol === page.protocol) return candidate.host === page.host;
  } catch {
    return false;
  }
  return isControlledAssetUrlAllowed(scope.capture, rawUrl);
}

export function documentPageScope(scheme: string, inputUrl: string): DocumentPageScope | null {
  const capture = controlledAssetScope(inputUrl);
  if (capture === null) return null;
  if (!new URL(capture.sourceUrl).pathname.endsWith(`/${SCIENT_DOCUMENT_CAPTURE_INPUT_FILE}`)) {
    return null;
  }
  return {
    pageUrl: documentPageUrl(scheme, capture.sourceUrl),
    pageOrigin: documentPageOrigin(scheme),
    capture,
  };
}

interface DocumentPageWindow {
  readonly loadURL: (url: string) => Promise<unknown>;
  readonly destroy: () => void;
  readonly isDestroyed: () => boolean;
  readonly webContents: WebContents;
}

export interface DocumentPagePdfRendererOptions {
  readonly page: DocumentPageSource;
  readonly createWindow?: (options: BrowserWindowConstructorOptions) => DocumentPageWindow;
  readonly print?: (
    webContents: WebContents,
  ) => Effect.Effect<DesktopPreviewPdfExportArtifact, BrowserPdfRendererError>;
  readonly readReadiness?: (webContents: WebContents) => Promise<unknown>;
  readonly fetchDevelopment?: (url: string) => Promise<Response>;
  readonly timeoutMs?: number;
}

const readinessScript = `
  (async () => {
    for (let attempt = 0; attempt < ${READINESS_POLL_ATTEMPTS}; attempt += 1) {
      const readiness = window.${SCIENT_DOCUMENT_PAGE_READINESS_GLOBAL};
      if (readiness) return await readiness;
      await new Promise((resolve) => setTimeout(resolve, ${READINESS_POLL_INTERVAL_MS}));
    }
    return null;
  })()
`;

const decodeReadiness = Schema.decodeUnknownEffect(ScientDocumentPageReadiness);

const rejected = (
  reason: Extract<DesktopDocumentPageRenderOutcome, { _tag: "rejected" }>["reason"],
  detail: string,
): DesktopDocumentPageRenderOutcome => ({
  _tag: "rejected",
  reason,
  detail: detail.slice(0, 2_048),
});

class DocumentPageRejection extends Data.TaggedError("DocumentPageRejection")<{
  readonly outcome: DesktopDocumentPageRenderOutcome;
}> {}

const ensureProtocol = (
  session: Session,
  source: DocumentPageSource,
  fetchDevelopment: (url: string) => Promise<Response>,
) => {
  if (session.protocol.isProtocolHandled(source.scheme)) return;
  session.protocol.handle(source.scheme, (request) =>
    serveDocumentPageFile(source.files, request, fetchDevelopment).catch(
      () => new Response(null, { status: 500 }),
    ),
  );
};

export function createDocumentPagePdfRenderer(options: DocumentPagePdfRendererOptions) {
  const createWindow =
    options.createWindow ??
    ((windowOptions: BrowserWindowConstructorOptions) => new Electron.BrowserWindow(windowOptions));
  const print = options.print ?? createBrowserPdfRenderer({ marginPolicy: "source-authored" });
  const readReadiness =
    options.readReadiness ??
    ((webContents: WebContents) => webContents.executeJavaScript(readinessScript, true));
  const fetchDevelopment = options.fetchDevelopment ?? ((url: string) => Electron.net.fetch(url));
  const timeoutMs = options.timeoutMs ?? DOCUMENT_PAGE_TIMEOUT_MS;
  // Chromium print jobs compete for renderer resources; one document at a time.
  const permit = Semaphore.makeUnsafe(1);

  const render = (
    input: DesktopDocumentPageRenderInput,
  ): Effect.Effect<DesktopDocumentPageRenderOutcome> => {
    const scope = documentPageScope(options.page.scheme, input.inputUrl);
    if (scope === null) {
      return Effect.succeed(
        rejected("failed", "Only a signed Scient document capture can be rendered."),
      );
    }
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const window = createWindow({
          show: false,
          width: 1_024,
          height: 1_400,
          backgroundColor: "#ffffff",
          webPreferences: {
            partition: DOCUMENT_PAGE_PARTITION,
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
        ensureProtocol(browserSession, options.page, fetchDevelopment);
        const blockedRequests = { count: 0 };
        const blockEscapingRequest = (
          details: Electron.OnBeforeRequestListenerDetails,
          callback: (response: Electron.CallbackResponse) => void,
        ) => {
          const allowed = isDocumentPageRequestAllowed(scope, details.url);
          if (!allowed) blockedRequests.count += 1;
          callback({ cancel: !allowed });
        };
        const preventNavigation = (event: Electron.Event, url: string) => {
          if (url !== scope.pageUrl) {
            blockedRequests.count += 1;
            event.preventDefault();
          }
        };
        const preventDefault = (event: Electron.Event) => event.preventDefault();
        browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
          callback(false),
        );
        browserSession.setPermissionCheckHandler(() => false);
        browserSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, blockEscapingRequest);
        browserSession.on("will-download", preventDefault);
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", preventNavigation);
        window.webContents.on("will-redirect", preventNavigation);
        window.webContents.on("will-attach-webview", preventDefault);
        return {
          window,
          blockedRequests,
          cleanup: async () => {
            window.webContents.off("will-navigate", preventNavigation);
            window.webContents.off("will-redirect", preventNavigation);
            window.webContents.off("will-attach-webview", preventDefault);
            browserSession.off("will-download", preventDefault);
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
      }),
      ({ window, blockedRequests }) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => window.loadURL(scope.pageUrl),
            catch: () =>
              new DocumentPageRejection({
                outcome: rejected("failed", "The document page could not be loaded."),
              }),
          });
          yield* waitForLoadSettlement(window.webContents).pipe(
            Effect.mapError(
              () =>
                new DocumentPageRejection({
                  outcome: rejected("failed", "The document page did not finish loading."),
                }),
            ),
          );
          const raw = yield* Effect.tryPromise({
            try: () => readReadiness(window.webContents),
            catch: () =>
              new DocumentPageRejection({
                outcome: rejected(
                  "page-rejected",
                  "The document page did not report its readiness.",
                ),
              }),
          });
          if (raw === null || raw === undefined) {
            return yield* new DocumentPageRejection({
              outcome: rejected("page-rejected", "The document page did not start rendering."),
            });
          }
          const readiness = yield* decodeReadiness(raw).pipe(
            Effect.mapError(
              () =>
                new DocumentPageRejection({
                  outcome: rejected(
                    "page-rejected",
                    "The document page reported an invalid readiness.",
                  ),
                }),
            ),
          );
          const rejection = scientDocumentReadinessRejection(readiness, input.expected);
          if (rejection !== null) {
            return yield* new DocumentPageRejection({
              outcome: rejected("page-rejected", rejection),
            });
          }
          const artifact = yield* print(window.webContents).pipe(
            Effect.mapError(
              (cause) =>
                new DocumentPageRejection({
                  outcome:
                    cause.operation === "exportPdf.tooLarge"
                      ? rejected(
                          "too-large",
                          "The PDF is larger than Scient's 64 MiB export limit.",
                        )
                      : rejected("failed", "Chromium could not print the document page."),
                }),
            ),
          );
          return {
            _tag: "rendered",
            artifact: {
              data: artifact.data,
              readiness,
              warnings: artifact.warnings.slice(0, 32),
              sourceSignals: artifact.sourceSignals,
              blockedRequestCount: blockedRequests.count,
            },
          } satisfies DesktopDocumentPageRenderOutcome;
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () =>
              Effect.fail(
                new DocumentPageRejection({
                  outcome: rejected(
                    "page-rejected",
                    "The document page did not finish rendering in time.",
                  ),
                }),
              ),
          }),
          Effect.catch((cause) => Effect.succeed(cause.outcome)),
        ),
      ({ cleanup }) => Effect.promise(() => cleanup().catch(() => undefined)),
    ).pipe(
      Effect.catchCause(() =>
        Effect.succeed(rejected("failed", "Scient could not open the hidden document renderer.")),
      ),
    );
  };

  return (input: DesktopDocumentPageRenderInput) => permit.withPermit(render(input));
}
