import { it as effectIt } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { describe, expect, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as PreviewManager from "./Manager.ts";
import * as PreviewPasskeys from "./Passkeys.ts";

const { browserWindowConstructor, fromId } = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  fromId: vi.fn<(_id?: number) => Electron.WebContents | null>((_id?: number) => null),
}));

vi.mock("electron", () => ({
  BrowserWindow: browserWindowConstructor,
  session: { fromPartition: vi.fn() },
  webContents: { fromId, getFocusedWebContents: vi.fn(() => null) },
}));

const managerLayer = PreviewManager.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
      register: () => Effect.void,
      recordMetrics: () => Effect.void,
      shutdown: Effect.void,
    }),
  ),
  Layer.provideMerge(DesktopBrowserHost.layer),
  Layer.provideMerge(
    Layer.succeed(
      BrowserSession.BrowserSession,
      BrowserSession.BrowserSession.of({
        getPartition: () => Effect.succeed("persist:scient-next-preview-test"),
        isPartition: (partition) => partition.startsWith("persist:scient-next-preview-"),
        getSession: () => Effect.succeed({ on: vi.fn() } as unknown as Electron.Session),
        clearCookies: () => Effect.void,
        clearCache: () => Effect.void,
      }),
    ),
  ),
  Layer.provideMerge(
    Layer.mock(PreviewPasskeys.PreviewPasskeys)({
      bridgeEnabled: false,
      installSessionHandlers: () => {},
      attachGuest: () => () => {},
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      DesktopEnvironment.DesktopEnvironment,
      DesktopEnvironment.DesktopEnvironment.of({
        browserArtifactsDir: "/tmp/t3/dev/browser-artifacts",
        dirname: "/tmp/t3/desktop",
        path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
    ),
  ),
  Layer.provideMerge(FileSystem.layerNoop({})),
  Layer.provideMerge(Path.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Layer.succeed(HostProcess.Platform, "darwin")),
);

const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager["Service"],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* use(manager);
  }).pipe(Effect.provide(managerLayer), Effect.scoped);

type DisplayMediaHandler = (
  request: { readonly frame: { readonly frameTreeNodeId: number } | null },
  callback: (streams: { video?: unknown }) => void,
) => void;

const makeHostWebContents = (id: number) => {
  let handler: DisplayMediaHandler | undefined;
  return {
    id,
    mainFrame: { frameTreeNodeId: id },
    executeJavaScript: vi.fn(async () => true),
    isDestroyed: () => false,
    setBackgroundThrottling: vi.fn<(enabled: boolean) => void>(),
    session: {
      setDisplayMediaRequestHandler: vi.fn((next: DisplayMediaHandler) => {
        handler = next;
      }),
    },
    grantPendingRecording: () => handler?.({ frame: { frameTreeNodeId: id } }, () => {}),
  };
};

const makeAppWindow = (id: number) => {
  const webContents = makeHostWebContents(id);
  let destroyed = false;
  let closedListener: (() => void) | undefined;
  const window = {
    isDestroyed: () => destroyed,
    once: (event: string, listener: () => void) => {
      if (event === "closed") closedListener = listener;
    },
    webContents,
  };
  return {
    webContents,
    window: window as unknown as Electron.BrowserWindow,
    close: () => {
      destroyed = true;
      closedListener?.();
    },
  };
};

const makeGuest = (id: number, hostWebContents: unknown) => {
  let markRestored!: () => void;
  const restored = new Promise<void>((resolve) => {
    markRestored = resolve;
  });
  const guest = {
    id,
    mainFrame: { routingId: id },
    hostWebContents,
    executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => "https://example.com",
    getTitle: () => "Example",
    isLoadingMainFrame: () => false,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    setAudioMuted: vi.fn(),
    setBackgroundThrottling: vi.fn((enabled: boolean) => {
      if (enabled) markRestored();
    }),
    isCurrentlyAudible: () => false,
    on: vi.fn(),
    off: vi.fn(),
    ipc: { on: vi.fn(), off: vi.fn() },
    send: vi.fn(),
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setIgnoreMenuShortcuts: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => undefined),
      on: vi.fn(),
      off: vi.fn(),
    },
    capturePage: vi.fn(async () => ({
      toJPEG: () => Buffer.from("frame"),
      getSize: () => ({ width: 1280, height: 720 }),
    })),
  };
  return { guest: guest as unknown as Electron.WebContents, restored };
};

const makePictureInPictureWindow = () => {
  let destroyed = false;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const listeners = new Map<string, () => void>();
  const window = {
    isDestroyed: () => destroyed,
    once: (event: string, listener: () => void) => listeners.set(event, listener),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setAspectRatio: vi.fn(),
    getContentSize: () => [480, 320],
    setContentSize: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    showInactive: vi.fn(),
    close: () => {
      if (destroyed) return;
      destroyed = true;
      listeners.get("closed")?.();
      markClosed();
    },
    webContents: { on: vi.fn(), off: vi.fn(), send: vi.fn() },
  };
  return { window, closed };
};

const expectMainWindowClosed = (exit: Exit.Exit<unknown, unknown>, tabId: string) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
      _tag: "PreviewMainWindowClosedError",
      tabId,
    });
  }
};

describe("PreviewManager with several app windows", () => {
  effectIt.effect("accepts guests hosted by any registered app window", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const first = makeAppWindow(7);
        const second = makeAppWindow(8);
        const guests = new Map([
          [41, makeGuest(41, first.webContents).guest],
          [42, makeGuest(42, second.webContents).guest],
          [43, makeGuest(43, makeHostWebContents(9)).guest],
        ]);
        fromId.mockImplementation((id) => (id === undefined ? null : (guests.get(id) ?? null)));
        yield* manager.setMainWindow(first.window);
        yield* manager.setMainWindow(second.window);
        yield* manager.setMainWindow(first.window);

        yield* manager.createTab("tab_first");
        yield* manager.createTab("tab_second");
        yield* manager.createTab("tab_foreign");
        yield* manager.registerWebview("tab_first", 41);
        yield* manager.registerWebview("tab_second", 42);
        const foreign = yield* Effect.exit(manager.registerWebview("tab_foreign", 43));
        expect(Exit.isFailure(foreign)).toBe(true);
        if (Exit.isFailure(foreign)) {
          expect(Option.getOrThrow(Cause.findErrorOption(foreign.cause))).toMatchObject({
            _tag: "PreviewWebContentsNotFoundError",
            tabId: "tab_foreign",
          });
        }
      }),
    ),
  );

  effectIt.effect(
    "releases captures of the closed window's tabs and everything once the last window closes",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const first = makeAppWindow(7);
          const second = makeAppWindow(8);
          const firstGuest = makeGuest(41, first.webContents);
          const secondGuest = makeGuest(42, second.webContents);
          const unhostedGuest = makeGuest(43, makeHostWebContents(9));
          const guests = new Map([
            [41, firstGuest.guest],
            [42, secondGuest.guest],
            [43, unhostedGuest.guest],
          ]);
          fromId.mockImplementation((id) => (id === undefined ? null : (guests.get(id) ?? null)));
          const pictureInPictureWindows = new Map([
            ["tab_first", makePictureInPictureWindow()],
            ["tab_second", makePictureInPictureWindow()],
            ["tab_unhosted", makePictureInPictureWindow()],
          ]);
          let nextPictureInPicture = pictureInPictureWindows.values();
          browserWindowConstructor.mockImplementation(function () {
            return nextPictureInPicture.next().value?.window;
          });

          yield* manager.createTab("tab_unhosted");
          yield* manager.registerWebview("tab_unhosted", 43);
          yield* manager.setMainWindow(first.window);
          yield* manager.setMainWindow(second.window);
          yield* manager.createTab("tab_first");
          yield* manager.createTab("tab_second");
          yield* manager.registerWebview("tab_first", 41);
          yield* manager.registerWebview("tab_second", 42);

          yield* manager.startRecording("tab_first");
          first.webContents.grantPendingRecording();
          yield* manager.startRecording("tab_second");
          second.webContents.grantPendingRecording();
          for (const tabId of pictureInPictureWindows.keys()) {
            yield* manager.openPictureInPicture(tabId);
          }
          expect(first.webContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
          expect(second.webContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);

          first.close();
          yield* Effect.promise(() =>
            Promise.all([firstGuest.restored, pictureInPictureWindows.get("tab_first")!.closed]),
          );
          expectMainWindowClosed(
            yield* Effect.exit(manager.startRecording("tab_first")),
            "tab_first",
          );
          expect(secondGuest.guest.setBackgroundThrottling).not.toHaveBeenCalledWith(true);
          expect(unhostedGuest.guest.setBackgroundThrottling).not.toHaveBeenCalledWith(true);
          expect(pictureInPictureWindows.get("tab_second")!.window.isDestroyed()).toBe(false);
          expect(pictureInPictureWindows.get("tab_unhosted")!.window.isDestroyed()).toBe(false);
          expect(second.webContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);

          second.close();
          yield* Effect.promise(() =>
            Promise.all([
              secondGuest.restored,
              unhostedGuest.restored,
              pictureInPictureWindows.get("tab_second")!.closed,
              pictureInPictureWindows.get("tab_unhosted")!.closed,
            ]),
          );
          nextPictureInPicture = [makePictureInPictureWindow()].values();
          expectMainWindowClosed(
            yield* Effect.exit(manager.openPictureInPicture("tab_unhosted")),
            "tab_unhosted",
          );
        }),
      ),
  );
});
