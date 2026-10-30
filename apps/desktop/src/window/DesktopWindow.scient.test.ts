import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      },
    ]),
    getPrimaryDisplay: vi.fn(() => ({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    })),
  },
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const MAIN_BOUNDS = { x: 100, y: 80, width: 1280, height: 840 };

function makeFakeWindow() {
  const webContents = {
    getURL: vi.fn(() => ""),
    getZoomFactor: vi.fn(() => 1),
    isDestroyed: vi.fn(() => false),
    isLoadingMainFrame: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    openDevTools: vi.fn(),
    send: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  const window = {
    close: vi.fn(),
    getBounds: vi.fn(() => MAIN_BOUNDS),
    getNormalBounds: vi.fn(() => MAIN_BOUNDS),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isNormal: vi.fn(() => true),
    loadURL: vi.fn((_url: string) => Promise.resolve()),
    maximize: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    setAutoHideCursor: vi.fn(),
    setTitle: vi.fn(),
    setWindowButtonPosition: vi.fn(),
    show: vi.fn(),
    webContents,
  };
  return { window: window as unknown as Electron.BrowserWindow, loadURL: window.loadURL };
}

const layerDesktopEnvironment = DesktopEnvironment.layer({
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      DesktopConfig.layerTest({
        T3CODE_PORT: "3773",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
      }),
    ),
  ),
);

const makeHarness = Effect.gen(function* () {
  const fakes = [makeFakeWindow(), makeFakeWindow()] as const;
  const createdOptions = yield* Ref.make<Electron.BrowserWindowConstructorOptions[]>([]);
  const mainWindow = yield* Ref.make(Option.none<Electron.BrowserWindow>());
  const revealed = yield* Ref.make<Electron.BrowserWindow[]>([]);

  const electronWindow = {
    create: (options) =>
      Ref.modify(createdOptions, (created) => {
        const fake = fakes[created.length];
        if (fake === undefined) throw new Error("unexpected extra window");
        return [fake.window, [...created, options]];
      }),
    main: Ref.get(mainWindow),
    appWindows: Ref.get(mainWindow).pipe(Effect.map(Option.toArray)),
    currentMainOrFirst: Ref.get(mainWindow),
    focusedMainOrFirst: Ref.get(mainWindow),
    setMain: (window) => Ref.set(mainWindow, Option.some(window)),
    clearMain: () => Ref.set(mainWindow, Option.none()),
    prepareReveal: () => Effect.succeed(false),
    reveal: (window) => Ref.update(revealed, (windows) => [...windows, window]),
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"];

  const layer = DesktopWindow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopAssets.DesktopAssets, {
          iconPaths: Effect.succeed({
            ico: Option.none<string>(),
            icns: Option.none<string>(),
            png: Option.none<string>(),
          }),
          resolveResourcePath: () => Effect.succeedNone,
        }),
        Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
          register: () => Effect.void,
          recordMetrics: () => Effect.void,
          shutdown: Effect.void,
        }),
        layerDesktopEnvironment,
        DesktopAppSettings.layerTest(),
        Layer.mock(DesktopClientSettings.DesktopClientSettings)({ get: Effect.succeedNone }),
        DesktopState.layer,
        Layer.mock(ElectronApp.ElectronApp)({ quit: Effect.void }),
        Layer.mock(ElectronMenu.ElectronMenu)({}),
        Layer.mock(ElectronShell.ElectronShell)({}),
        Layer.mock(ElectronTheme.ElectronTheme)({ shouldUseDarkColors: Effect.succeed(false) }),
        Layer.succeed(ElectronWindow.ElectronWindow, electronWindow),
        Layer.mock(PreviewPasskeys.PreviewPasskeys)({
          bridgeEnabled: false,
          installSessionHandlers: () => {},
          attachGuest: () => () => {},
        }),
        Layer.mock(PreviewManager.PreviewManager)({
          getBrowserSession: () => Effect.succeed({} as Electron.Session),
          setMainWindow: () => Effect.void,
          isBrowserPartition: () => false,
        }),
      ),
    ),
    Layer.merge(DesktopState.layer),
  );

  return { fakes, createdOptions, mainWindow, revealed, layer } as const;
});

describe("DesktopWindow.openNewWindow", () => {
  it.effect("opens the route in a new main window cascaded from the current main window", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const [main, added] = harness.fakes;

      yield* Effect.gen(function* () {
        const windows = yield* DesktopWindow.DesktopWindow;
        yield* windows.handleBackendReady(new URL("http://127.0.0.1:3773"));
        assert.strictEqual(Option.getOrThrow(yield* Ref.get(harness.mainWindow)), main.window);

        assert.isTrue(yield* windows.openNewWindow("/settings/general"));

        const created = yield* Ref.get(harness.createdOptions);
        assert.equal(created.length, 2);
        assert.deepInclude(created[1], { x: 128, y: 108, width: 1280, height: 840 });
        const mainUrl = main.loadURL.mock.calls[0]?.[0];
        assert.isString(mainUrl);
        assert.deepEqual(
          added.loadURL.mock.calls.map(([url]) => url),
          [new URL("#/settings/general", mainUrl).href],
        );
        assert.strictEqual(Option.getOrThrow(yield* Ref.get(harness.mainWindow)), added.window);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("opens nothing and leaves the splash hidden once quitting has started", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;

      yield* Effect.gen(function* () {
        const windows = yield* DesktopWindow.DesktopWindow;
        const state = yield* DesktopState.DesktopState;
        yield* windows.showConnectingSplash;
        yield* Ref.set(state.quitting, true);

        assert.isFalse(yield* windows.openNewWindow("/settings/general"));

        assert.equal((yield* Ref.get(harness.createdOptions)).length, 1);
        assert.deepEqual(yield* Ref.get(harness.revealed), []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reveals the splash instead of opening a window before the backend is ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const [splash] = harness.fakes;

      yield* Effect.gen(function* () {
        const windows = yield* DesktopWindow.DesktopWindow;
        yield* windows.showConnectingSplash;

        assert.isFalse(yield* windows.openNewWindow("/settings/general"));

        assert.equal((yield* Ref.get(harness.createdOptions)).length, 1);
        assert.deepEqual(yield* Ref.get(harness.revealed), [splash.window]);
        assert.isTrue(Option.isNone(yield* Ref.get(harness.mainWindow)));
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
