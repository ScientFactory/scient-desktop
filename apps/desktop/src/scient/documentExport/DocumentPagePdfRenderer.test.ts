// @effect-diagnostics nodeBuiltinImport:off -- Tests serve fixture client files from a temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ScientDocumentPageExpectation } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import {
  createDocumentPagePdfRenderer,
  documentPageContentSecurityPolicy,
  documentPageScope,
  isDocumentPageRequestAllowed,
  servePackagedDocumentPageFile,
} from "./DocumentPagePdfRenderer.ts";

vi.mock("electron", () => ({ BrowserWindow: vi.fn(), net: { fetch: vi.fn() } }));

const inputUrl = "https://environment.test/api/assets/signed-token/document.json";
const expected: ScientDocumentPageExpectation = {
  captureId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  documentKind: "workspace-file",
  sourceDigest: `sha256:${"a".repeat(64)}`,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

const readiness = (overrides: Record<string, unknown> = {}) => ({
  protocol: 1,
  status: "ready",
  captureId: expected.captureId,
  documentKind: expected.documentKind,
  sourceDigest: expected.sourceDigest,
  title: "Report",
  blocks: {
    headings: 1,
    paragraphs: 1,
    lists: 0,
    tables: 0,
    codeBlocks: 0,
    inlineMath: 0,
    displayMath: 0,
    diagrams: 0,
    images: 0,
  },
  unresolvedAssets: [],
  settled: { fonts: true, math: true, diagrams: true, images: true },
  diagnostics: [],
  ...overrides,
});

const printed = {
  data: new TextEncoder().encode("%PDF-1.7\nfixture"),
  sourceUrl: "scient://app/scient-document.html",
  title: "Report",
  profile: "document-layout" as const,
  media: "print" as const,
  warnings: [],
  sourceSignals: {
    bodyTextLength: 10,
    imageCount: 0,
    brokenImageCount: 0,
    canvasCount: 0,
    videoCount: 0,
    iframeCount: 0,
    scrollWidth: 800,
    scrollHeight: 1_000,
  },
};

function makeWindow() {
  let beforeRequest:
    | ((
        details: { readonly url: string },
        callback: (response: { readonly cancel?: boolean }) => void,
      ) => void)
    | null = null;
  const handled = new Set<string>();
  const protocolHandle = vi.fn((scheme: string) => handled.add(scheme));
  const webContentsListeners = new Map<string, (...args: unknown[]) => void>();
  const browserSession = {
    protocol: {
      isProtocolHandled: vi.fn((scheme: string) => handled.has(scheme)),
      handle: protocolHandle,
    },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    webRequest: {
      onBeforeRequest: vi.fn((filterOrListener, maybeListener) => {
        beforeRequest = maybeListener === undefined ? filterOrListener : maybeListener;
      }),
    },
    on: vi.fn(),
    off: vi.fn(),
    clearCache: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
  };
  let destroyed = false;
  const window = {
    webContents: {
      session: browserSession,
      setWindowOpenHandler: vi.fn(),
      isLoading: vi.fn(() => false),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        webContentsListeners.set(event, listener);
      }),
      off: vi.fn((event: string) => {
        webContentsListeners.delete(event);
      }),
    },
    loadURL: vi.fn(async () => undefined),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    isDestroyed: () => destroyed,
  };
  return {
    window,
    browserSession,
    protocolHandle,
    webContentsListeners,
    request: (url: string) => {
      let cancelled: boolean | undefined;
      beforeRequest!({ url }, (response) => {
        cancelled = response.cancel;
      });
      return cancelled === false;
    },
  };
}

const page = { scheme: "scient", files: { _tag: "packaged", assetDirectory: "/client" } } as const;

describe("DocumentPagePdfRenderer", () => {
  it("limits the page to its own files and the one signed capture", () => {
    const scope = documentPageScope("scient", inputUrl)!;
    expect(scope.pageUrl).toBe(
      `scient://app/scient-document.html#input=${encodeURIComponent(inputUrl)}`,
    );
    expect(isDocumentPageRequestAllowed(scope, "scient://app/assets/index-abc.js")).toBe(true);
    expect(
      isDocumentPageRequestAllowed(
        scope,
        "https://environment.test/api/assets/signed-token/assets/0001.png",
      ),
    ).toBe(true);
    expect(
      isDocumentPageRequestAllowed(scope, "https://environment.test/api/assets/other/x.png"),
    ).toBe(false);
    expect(isDocumentPageRequestAllowed(scope, "scient://evil/assets/index.js")).toBe(false);
    expect(isDocumentPageRequestAllowed(scope, "https://environment.test/ws")).toBe(false);
    expect(isDocumentPageRequestAllowed(scope, "https://example.com/tracker.png")).toBe(false);
    expect(isDocumentPageRequestAllowed(scope, "ws://localhost:5733/")).toBe(false);
    expect(documentPageScope("scient", "https://environment.test/api/assets/t/page.html")).toBe(
      null,
    );
    expect(documentPageScope("scient", "https://example.com/document.json")).toBe(null);
  });

  it("serves only the page entry and hashed build assets from the packaged client", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-page-"));
    temporaryDirectories.push(directory);
    await NodeFSP.mkdir(NodePath.join(directory, "assets"));
    await NodeFSP.writeFile(NodePath.join(directory, "scient-document.html"), "<!doctype html>");
    await NodeFSP.writeFile(NodePath.join(directory, "assets", "page-abc.js"), "export {}");
    await NodeFSP.writeFile(NodePath.join(directory, "index.html"), "app shell");
    const get = (url: string) => servePackagedDocumentPageFile(directory, new Request(url));

    const entry = await get("scient://app/scient-document.html");
    expect(entry.status).toBe(200);
    expect(entry.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect((await get("scient://app/assets/page-abc.js")).headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    for (const url of [
      "scient://app/index.html",
      "scient://app/",
      "scient://app/assets/../index.html",
      "scient://app/assets/%2e%2e%2findex.html",
      "scient://other/scient-document.html",
    ]) {
      expect((await get(url)).status, url).toBe(404);
    }
    expect(documentPageContentSecurityPolicy(page.files)).toContain("script-src 'self';");
    expect(documentPageContentSecurityPolicy(page.files)).toContain("object-src 'none'");
  });

  it.effect("prints only after a matching readiness report, in an isolated window", () =>
    Effect.gen(function* () {
      const fixture = makeWindow();
      let partition: string | undefined;
      const print = vi.fn(() => Effect.succeed(printed));
      const render = createDocumentPagePdfRenderer({
        page,
        createWindow: (options) => {
          partition = options.webPreferences?.partition;
          return fixture.window as never;
        },
        readReadiness: async () => {
          expect(fixture.request("https://example.com/beacon")).toBe(false);
          return readiness();
        },
        print,
      });

      const outcome = yield* render({ inputUrl, expected });

      expect(outcome).toMatchObject({
        _tag: "rendered",
        artifact: { readiness: { status: "ready" }, blockedRequestCount: 1 },
      });
      expect(partition).toBe("scient-next-document-page");
      expect(fixture.protocolHandle).toHaveBeenCalledWith("scient", expect.any(Function));
      expect(fixture.window.loadURL).toHaveBeenCalledWith(
        documentPageScope("scient", inputUrl)!.pageUrl,
      );
      expect(print).toHaveBeenCalledOnce();
      expect(fixture.window.destroy).toHaveBeenCalledOnce();
      expect(fixture.browserSession.clearStorageData).toHaveBeenCalledOnce();
      expect(fixture.webContentsListeners.size).toBe(0);
    }),
  );

  it.effect("refuses a wrong, stale, or unfinished page without printing", () =>
    Effect.gen(function* () {
      for (const [overrides, detail] of [
        [{ documentKind: "conversation" }, "wrong kind"],
        [{ sourceDigest: `sha256:${"b".repeat(64)}` }, "different source revision"],
        [{ captureId: "00000000-0000-4000-8000-000000000000" }, "different capture"],
        [
          {
            status: "failed",
            diagnostics: [
              {
                severity: "fatal",
                code: "diagram-incomplete",
                detail: "1 diagram did not finish rendering.",
              },
            ],
          },
          "1 diagram did not finish rendering.",
        ],
      ] as const) {
        const fixture = makeWindow();
        const print = vi.fn(() => Effect.succeed(printed));
        const render = createDocumentPagePdfRenderer({
          page,
          createWindow: () => fixture.window as never,
          readReadiness: async () => readiness(overrides),
          print,
        });
        const outcome = yield* render({ inputUrl, expected });
        expect(outcome).toMatchObject({ _tag: "rejected", reason: "page-rejected" });
        expect(outcome._tag === "rejected" ? outcome.detail : "").toContain(detail);
        expect(print).not.toHaveBeenCalled();
        expect(fixture.window.destroy).toHaveBeenCalledOnce();
      }
    }),
  );

  it.effect("reports invalid readiness, oversized output, and non-capture inputs", () =>
    Effect.gen(function* () {
      const invalid = makeWindow();
      const invalidOutcome = yield* createDocumentPagePdfRenderer({
        page,
        createWindow: () => invalid.window as never,
        readReadiness: async () => ({ status: "ready" }),
        print: () => Effect.succeed(printed),
      })({ inputUrl, expected });
      expect(invalidOutcome).toMatchObject({ _tag: "rejected", reason: "page-rejected" });

      const large = makeWindow();
      const largeOutcome = yield* createDocumentPagePdfRenderer({
        page,
        createWindow: () => large.window as never,
        readReadiness: async () => readiness(),
        print: () =>
          Effect.fail({ _tag: "BrowserPdfRendererError", operation: "exportPdf.tooLarge" }),
      })({ inputUrl, expected });
      expect(largeOutcome).toMatchObject({ _tag: "rejected", reason: "too-large" });

      const createWindow = vi.fn();
      const foreign = yield* createDocumentPagePdfRenderer({ page, createWindow })({
        inputUrl: "https://example.com/document.json",
        expected,
      });
      expect(foreign).toMatchObject({ _tag: "rejected", reason: "failed" });
      expect(createWindow).not.toHaveBeenCalled();
    }),
  );
});
