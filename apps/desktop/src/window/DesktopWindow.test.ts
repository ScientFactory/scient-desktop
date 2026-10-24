import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import { DesktopSnapShotId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  session: {
    fromPartition: vi.fn(() => ({
      getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/1.2.3"),
      setPermissionRequestHandler: vi.fn(),
      setUserAgent: vi.fn(),
    })),
  },
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        // SCIENT-FORK:START scient-window
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      },
    ]),
    getPrimaryDisplay: vi.fn(() => ({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    })),
    // SCIENT-FORK:END scient-window
  },
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
// SCIENT-FORK:START scient-window
import { MENU_ACTION_CHANNEL, SNAP_SHOT_EVENT_CHANNEL } from "../ipc/channels.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as PreviewManager from "../preview/Manager.ts";
import { DesktopTelemetryPublisher } from "../telemetry/DesktopTelemetryPublisher.ts";
// SCIENT-FORK:END scient-window
import * as PreviewPasskeys from "../preview/Passkeys.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

function makeFakeBrowserWindow() {
  const windowListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const webContentsListeners = new Map<string, (...args: readonly unknown[]) => void>();
  let zoomLevel = 0;
  const webContents = {
    copyImageAt: vi.fn(),
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    // SCIENT-FORK:START scient-window
    getURL: vi.fn(() => "scient-next-dev://app/"),
    // SCIENT-FORK:END scient-window
    getZoomLevel: vi.fn(() => zoomLevel),
    getZoomFactor: vi.fn(() => 1.2 ** zoomLevel),
    setZoomLevel: vi.fn((level: number) => {
      zoomLevel = level;
    }),
    isLoadingMainFrame: vi.fn(() => false),
    on: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      webContentsListeners.set(eventName, listener);
    }),
    once: vi.fn<(eventName: string, listener: (...args: readonly unknown[]) => void) => void>(),
    openDevTools: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    replaceMisspelling: vi.fn(),
    send: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    toggleDevTools: vi.fn(),
  };

  const window = {
    close: vi.fn(),
    focus: vi.fn(),
    // SCIENT-FORK:START scient-window
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1280, height: 840 })),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1280, height: 840 })),
    // SCIENT-FORK:END scient-window
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    loadURL: vi.fn(() => Promise.resolve()),
    maximize: vi.fn(),
    on: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      windowListeners.set(eventName, listener);
    }),
    once: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      windowListeners.set(eventName, listener);
    }),
    restore: vi.fn(),
    setBackgroundColor: vi.fn(),
    setAutoHideCursor: vi.fn(),
    setFullScreen: vi.fn(),
    setOpacity: vi.fn(),
    setTitle: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    setWindowButtonPosition: vi.fn(),
    show: vi.fn(),
    webContents,
  };

  return {
    window: window as unknown as Electron.BrowserWindow,
    getBounds: window.getBounds,
    getNormalBounds: window.getNormalBounds,
    isDestroyed: window.isDestroyed,
    isFullScreen: window.isFullScreen,
    isMaximized: window.isMaximized,
    isMinimized: window.isMinimized,
    loadURL: window.loadURL,
    maximize: window.maximize,
    openDevTools: webContents.openDevTools,
    reload: webContents.reload,
    reloadIgnoringCache: webContents.reloadIgnoringCache,
    toggleDevTools: webContents.toggleDevTools,
    send: webContents.send,
    setZoomLevel: webContents.setZoomLevel,
    setWindowButtonPosition: window.setWindowButtonPosition,
    setBackgroundThrottling: webContents.setBackgroundThrottling,
    setAutoHideCursor: window.setAutoHideCursor,
    setFullScreen: window.setFullScreen,
    setOpacity: window.setOpacity,
    webContentsListeners,
    webContentsOnce: webContents.once,
    windowListeners,
  };
}

const layerDesktopClientSettings = Layer.mock(DesktopClientSettings.DesktopClientSettings)({
  get: Effect.succeedNone,
});

const layerElectronApp = Layer.mock(ElectronApp.ElectronApp)({
  quit: Effect.void,
});

const layerDesktopAssets = Layer.succeed(DesktopAssets.DesktopAssets, {
  iconPaths: Effect.succeed({
    ico: Option.none<string>(),
    icns: Option.none<string>(),
    png: Option.none<string>(),
  }),
  resolveResourcePath: () => Effect.succeed(Option.none<string>()),
} satisfies DesktopAssets.DesktopAssets["Service"]);

const layerDesktopServerExposure = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 3773,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.die("unexpected getAdvertisedEndpoints"),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const layerElectronMenu = Layer.succeed(ElectronMenu.ElectronMenu, {
  setApplicationMenu: () => Effect.void,
  popupTemplate: () => Effect.void,
  showContextMenu: () => Effect.succeedNone,
} satisfies ElectronMenu.ElectronMenu["Service"]);

const layerElectronTheme = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
} satisfies ElectronTheme.ElectronTheme["Service"]);

const layerDesktopEnvironment = DesktopEnvironment.layer(environmentInput).pipe(
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

const desktopWindowBoundsEquivalence = Schema.toEquivalence(
  DesktopAppSettings.DesktopWindowBoundsSchema,
);

function layerTest(input: {
  readonly window: Electron.BrowserWindow;
  readonly createCount: Ref.Ref<number>;
  readonly mainWindow: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
  readonly createdWindowOptions?: Electron.BrowserWindowConstructorOptions[];
  readonly desktopSettings?: DesktopAppSettings.DesktopSettings;
  readonly mainWindowBoundsUpdates?: DesktopAppSettings.DesktopWindowBounds[];
  // SCIENT-FORK:START scient-window
  readonly mainWindowSizeIncreaseUpdates?: (DesktopAppSettings.DesktopWindowBounds | null)[];
  readonly mainWindowNearFullSizeUpdates?: (DesktopAppSettings.DesktopWindowBounds | null)[];
  // SCIENT-FORK:END scient-window
  readonly mainWindowMaximizedUpdates?: boolean[];
  readonly beforeMainWindowBoundsUpdate?: (
    bounds: DesktopAppSettings.DesktopWindowBounds,
  ) => Effect.Effect<void>;
  readonly setPreviewMainWindow?: (window: Electron.BrowserWindow) => Effect.Effect<void>;
  readonly destroyAll?: Effect.Effect<void>;
  readonly onWindowCreate?: Effect.Effect<void>;
  readonly openedExternalUrls?: unknown[];
  readonly copiedTexts?: string[];
  readonly onPopupTemplate?: (input: ElectronMenu.ElectronMenuTemplateInput) => Effect.Effect<void>;
  readonly previewZoomReapplies?: number[];
  // SCIENT-FORK:START scient-window
  readonly healthReports?: unknown[];
  // SCIENT-FORK:END scient-window
  readonly onReveal?: (window: Electron.BrowserWindow) => void;
  readonly focusedWindow?: Electron.BrowserWindow;
}) {
  let desktopSettings = input.desktopSettings ?? DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS;
  const layerDesktopAppSettings = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
    get: Effect.sync(() => desktopSettings),
    load: Effect.sync(() => desktopSettings),
    setMainWindowBounds: (bounds, isMaximized) =>
      Effect.gen(function* () {
        if (input.beforeMainWindowBoundsUpdate) {
          yield* input.beforeMainWindowBoundsUpdate(bounds);
        }
        const changed =
          desktopSettings.mainWindowBounds === null ||
          !desktopWindowBoundsEquivalence(desktopSettings.mainWindowBounds, bounds) ||
          desktopSettings.mainWindowMaximized !== isMaximized;
        if (changed) {
          desktopSettings = {
            ...desktopSettings,
            mainWindowBounds: bounds,
            mainWindowMaximized: isMaximized,
          };
          input.mainWindowBoundsUpdates?.push(bounds);
          input.mainWindowMaximizedUpdates?.push(isMaximized);
        }
        return { settings: desktopSettings, changed };
      }),
    // SCIENT-FORK:START scient-window
    applyMainWindowSizeIncrease: (bounds) =>
      Effect.sync(() => {
        const changed = !desktopSettings.mainWindowSizeIncreaseApplied;
        if (changed) {
          desktopSettings = {
            ...desktopSettings,
            mainWindowBounds: bounds,
            mainWindowMaximized: bounds !== null && desktopSettings.mainWindowMaximized,
            mainWindowSizeIncreaseApplied: true,
          };
          input.mainWindowSizeIncreaseUpdates?.push(bounds);
        }
        return { settings: desktopSettings, changed };
      }),
    applyMainWindowNearFullSize: (bounds) =>
      Effect.sync(() => {
        const changed = !desktopSettings.mainWindowNearFullSizeApplied;
        if (changed) {
          desktopSettings = {
            ...desktopSettings,
            mainWindowBounds: bounds,
            mainWindowMaximized: bounds !== null && desktopSettings.mainWindowMaximized,
            mainWindowNearFullSizeApplied: true,
          };
          input.mainWindowNearFullSizeUpdates?.push(bounds);
        }
        return { settings: desktopSettings, changed };
      }),
    setServerExposureMode: () => Effect.die("unexpected server exposure update"),
    setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
    setUpdateChannel: () => Effect.die("unexpected update channel change"),
    setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
    setWslDistro: () => Effect.die("unexpected WSL distro change"),
    setVoiceSelectedModelId: () => Effect.die("unexpected voice model change"),
    // SCIENT-FORK:END scient-window
    setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
    setLocalEnvironmentEnabled: () => Effect.die("unexpected local environment toggle"),
    applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
    applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
  } satisfies DesktopAppSettings.DesktopAppSettings["Service"]);

  const layerElectronWindow = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: (options) =>
      Effect.sync(() => {
        input.createdWindowOptions?.push(options);
      }).pipe(
        Effect.andThen(Ref.update(input.createCount, (count) => count + 1)),
        Effect.andThen(input.onWindowCreate ?? Effect.void),
        Effect.as(input.window),
      ),
    main: Ref.get(input.mainWindow),
    currentMainOrFirst: Ref.get(input.mainWindow),
    focusedMainOrFirst:
      input.focusedWindow === undefined
        ? Ref.get(input.mainWindow)
        : Effect.succeedSome(input.focusedWindow),
    setMain: (window) => Ref.set(input.mainWindow, Option.some(window)),
    clearMain: () => Ref.set(input.mainWindow, Option.none()),
    prepareReveal: () => Effect.succeed(false),
    reveal: (window) => Effect.sync(() => input.onReveal?.(window)),
    sendAll: () => Effect.void,
    destroyAll: input.destroyAll ?? Effect.void,
    syncAllAppearance: (sync) => sync(input.window),
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  return DesktopWindow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerDesktopAssets,
        Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
          register: () => Effect.void,
          recordMetrics: () => Effect.void,
          shutdown: Effect.void,
        }),
        // SCIENT-FORK:START scient-window
        Layer.mock(DesktopTelemetryPublisher)({
          publishHealth: (report) =>
            Effect.sync(() => {
              input.healthReports?.push(report);
            }),
        }),
        // SCIENT-FORK:END scient-window
        layerDesktopEnvironment,
        layerDesktopAppSettings,
        layerDesktopClientSettings,
        layerDesktopServerExposure,
        DesktopState.layer,
        layerElectronApp,
        Layer.succeed(ElectronMenu.ElectronMenu, {
          setApplicationMenu: () => Effect.void,
          showContextMenu: () => Effect.succeedNone,
          popupTemplate: input.onPopupTemplate ?? (() => Effect.void),
        }),
        Layer.succeed(ElectronShell.ElectronShell, {
          openExternal: (url) =>
            Effect.sync(() => {
              input.openedExternalUrls?.push(url);
              return true;
            }),
          openSystemSettings: () => Effect.succeed(true),
          copyText: (text) =>
            Effect.sync(() => {
              input.copiedTexts?.push(text);
            }),
          // SCIENT-FORK:START scient-window
          copyPng: () => Effect.succeed(true),
          // SCIENT-FORK:END scient-window
        } satisfies ElectronShell.ElectronShell["Service"]),
        layerElectronTheme,
        layerElectronWindow,
        Layer.mock(PreviewPasskeys.PreviewPasskeys)({
          bridgeEnabled: false,
          installSessionHandlers: () => {},
          attachGuest: () => () => {},
        }),
        Layer.mock(PreviewManager.PreviewManager)({
          getBrowserSession: () => Effect.succeed({} as Electron.Session),
          setMainWindow: input.setPreviewMainWindow ?? (() => Effect.void),
          prepareWebview: () => Effect.void,
          // SCIENT-FORK:START scient-window
          isBrowserPartition: (partition) => partition.startsWith("persist:scient-next-preview-"),
          getBrowserPartition: () => Effect.succeed("persist:scient-next-preview-test"),
          // SCIENT-FORK:END scient-window
          reapplyZoom: () =>
            Effect.sync(() => {
              input.previewZoomReapplies?.push(input.window.webContents.getZoomLevel());
            }),
        }),
      ),
    ),
    Layer.merge(DesktopState.layer),
  );
}

const makeSplashScenario = (createOutcomes: readonly (Electron.BrowserWindow | null)[]) =>
  Effect.gen(function* () {
    const createdWindows = yield* Ref.make<Electron.BrowserWindow[]>([]);
    const createCalls = yield* Ref.make(0);
    const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
    const revealedWindows = yield* Ref.make<Electron.BrowserWindow[]>([]);
    const fallbackWindow = createOutcomes.find(
      (window): window is Electron.BrowserWindow => window !== null,
    );

    const currentMainOrFirst = Effect.gen(function* () {
      const registered = yield* Ref.get(mainWindow);
      if (Option.isSome(registered)) {
        return registered;
      }
      const created = yield* Ref.get(createdWindows);
      return Option.fromNullishOr(created[0] ?? null);
    });

    const electronWindowShape = {
      create: () =>
        Effect.gen(function* () {
          const index = yield* Ref.getAndUpdate(createCalls, (count) => count + 1);
          const outcome = createOutcomes[index] ?? null;
          if (outcome === null) {
            return yield* new ElectronWindow.ElectronWindowCreateError({
              options: {
                title: null,
                width: null,
                height: null,
                minWidth: null,
                minHeight: null,
                show: null,
                modal: null,
                frame: null,
                transparent: null,
                backgroundColor: null,
                webPreferences: {
                  preload: null,
                  partition: null,
                  backgroundThrottling: null,
                  sandbox: null,
                  contextIsolation: null,
                  nodeIntegration: null,
                  webviewTag: null,
                },
              },
              cause: new Error("simulated window-open failure"),
            });
          }
          yield* Ref.update(createdWindows, (windows) => [...windows, outcome]);
          return outcome;
        }),
      main: Ref.get(mainWindow),
      currentMainOrFirst,
      focusedMainOrFirst: currentMainOrFirst,
      setMain: (window) => Ref.set(mainWindow, Option.some(window)),
      clearMain: () => Ref.set(mainWindow, Option.none()),
      prepareReveal: () => Effect.succeed(false),
      reveal: (window) => Ref.update(revealedWindows, (windows) => [...windows, window]),
      sendAll: () => Effect.void,
      destroyAll: Effect.void,
      syncAllAppearance: (sync) => (fallbackWindow ? sync(fallbackWindow) : Effect.void),
    } satisfies ElectronWindow.ElectronWindow["Service"];

    const layer = DesktopWindow.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerDesktopAssets,
          Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
            register: () => Effect.void,
            recordMetrics: () => Effect.void,
            shutdown: Effect.void,
          }),
          layerDesktopEnvironment,
          DesktopAppSettings.layerTest(),
          layerDesktopClientSettings,
          layerDesktopServerExposure,
          DesktopState.layer,
          layerElectronApp,
          layerElectronMenu,
          Layer.succeed(ElectronShell.ElectronShell, {
            openExternal: () => Effect.succeed(true),
            openSystemSettings: () => Effect.succeed(true),
            copyText: () => Effect.void,
            // SCIENT-FORK:START scient-window
            copyPng: () => Effect.succeed(true),
            // SCIENT-FORK:END scient-window
          } satisfies ElectronShell.ElectronShell["Service"]),
          layerElectronTheme,
          Layer.succeed(ElectronWindow.ElectronWindow, electronWindowShape),
          Layer.mock(PreviewPasskeys.PreviewPasskeys)({
            bridgeEnabled: false,
            installSessionHandlers: () => {},
            attachGuest: () => () => {},
          }),
          Layer.mock(PreviewManager.PreviewManager)({
            getBrowserSession: () => Effect.succeed({} as Electron.Session),
            setMainWindow: () => Effect.void,
            // SCIENT-FORK:START scient-window
            isBrowserPartition: (partition) => partition.startsWith("persist:scient-next-preview-"),
            getBrowserPartition: () => Effect.succeed("persist:scient-next-preview-test"),
            // SCIENT-FORK:END scient-window
          }),
        ),
      ),
    );

    return { layer, createCalls, mainWindow, revealedWindows } as const;
  });

const captureOne = DesktopSnapShotId.make("11111111-1111-4111-8111-111111111111");
const captureTwo = DesktopSnapShotId.make("22222222-2222-4222-8222-222222222222");

describe("DesktopWindow", () => {
  it("restores bounds only when the window fits within a connected display", () => {
    const persistedBounds = { x: 2040, y: 80, width: 1320, height: 880 };
    const displays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 2560, height: 1440 },
    ];

    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(persistedBounds, displays),
      persistedBounds,
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(persistedBounds, [displays[0]!]),
      DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE,
    );
  });

  // SCIENT-FORK:START scient-window
  it("opens eight points inside the usable screen without changing the native minimum", () => {
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(null, [], {
        x: 0,
        y: 24,
        width: 1180,
        height: 760,
      }),
      { width: 1164, height: 744 },
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(null, [], {
        x: 0,
        y: 25,
        width: 1728,
        height: 1005,
      }),
      { width: 1712, height: 989 },
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(null, [], {
        x: 0,
        y: 0,
        width: 820,
        height: 600,
      }),
      DesktopAppSettings.MIN_MAIN_WINDOW_SIZE,
    );
  });

  it("enlarges old defaults and near-full windows once while preserving custom sizes", () => {
    const display = {
      bounds: { x: 0, y: 0, width: 1728, height: 1117 },
      workArea: { x: 0, y: 25, width: 1728, height: 1005 },
    };
    const nearFull = { x: 15, y: 39, width: 1698, height: 977 };
    const target = { x: 8, y: 33, width: 1712, height: 989 };
    assert.deepEqual(
      DesktopWindow.resolveOneTimeNearFullMainWindowBounds(nearFull, false, [display]),
      target,
    );
    assert.deepEqual(
      DesktopWindow.resolveOneTimeNearFullMainWindowBounds(
        { x: 100, y: 100, width: 1280, height: 840 },
        false,
        [display],
      ),
      target,
    );
    const custom = { x: 200, y: 100, width: 1400, height: 850 };
    assert.strictEqual(
      DesktopWindow.resolveOneTimeNearFullMainWindowBounds(custom, false, [display]),
      custom,
    );
    assert.strictEqual(
      DesktopWindow.resolveOneTimeNearFullMainWindowBounds(nearFull, true, [display]),
      nearFull,
    );
    const external = {
      bounds: { x: 1728, y: 0, width: 2560, height: 1440 },
      workArea: { x: 1728, y: 25, width: 2560, height: 1350 },
    };
    assert.deepEqual(
      DesktopWindow.resolveOneTimeNearFullMainWindowBounds(
        { x: 1900, y: 100, width: 1280, height: 840 },
        false,
        [display, external],
      ),
      { x: 1736, y: 33, width: 2544, height: 1334 },
    );
  });

  it("increases legacy bounds once on the same display without shrinking larger dimensions", () => {
    const primary = {
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 24, width: 1920, height: 1016 },
    };
    const secondary = {
      bounds: { x: 1920, y: 0, width: 1600, height: 900 },
      workArea: { x: 1920, y: 0, width: 1600, height: 860 },
    };
    assert.deepEqual(
      DesktopWindow.resolveOneTimeMainWindowSizeIncrease(
        { x: 2250, y: 150, width: 1050, height: 690 },
        [primary, secondary],
        primary,
      ),
      { x: 2240, y: 20, width: 1280, height: 840 },
    );
    assert.deepEqual(
      DesktopWindow.resolveOneTimeMainWindowSizeIncrease(
        { x: 300, y: 100, width: 1500, height: 700 },
        [primary],
        primary,
      ),
      { x: 300, y: 100, width: 1500, height: 840 },
    );
    const alreadyLarge = { x: 50, y: 8, width: 1500, height: 900 };
    assert.strictEqual(
      DesktopWindow.resolveOneTimeMainWindowSizeIncrease(alreadyLarge, [primary], primary),
      alreadyLarge,
    );
    assert.deepEqual(
      DesktopWindow.resolveOneTimeMainWindowSizeIncrease(
        { x: 3000, y: 100, width: 1000, height: 700 },
        [primary],
        primary,
      ),
      { x: 320, y: 112, width: 1280, height: 840 },
    );
    assert.isNull(DesktopWindow.resolveOneTimeMainWindowSizeIncrease(null, [primary], primary));
  });

  it("caps the one-time increase on small screens and relocates disconnected windows", () => {
    const primary = {
      bounds: { x: 0, y: 0, width: 1180, height: 800 },
      workArea: { x: 0, y: 20, width: 1180, height: 760 },
    };
    assert.deepEqual(
      DesktopWindow.resolveOneTimeMainWindowSizeIncrease(
        { x: 100, y: 90, width: 980, height: 680 },
        [primary],
        primary,
      ),
      { x: 0, y: 20, width: 1180, height: 760 },
    );
    assert.deepEqual(
      DesktopWindow.resolveOneTimeMainWindowSizeIncrease(
        { x: 2200, y: 90, width: 1000, height: 700 },
        [primary],
        primary,
      ),
      { x: 0, y: 20, width: 1180, height: 760 },
    );
  });

  it.effect(
    "reports bounded renderer failures without reporting clean exits or private details",
    () =>
      Effect.gen(function* () {
        const fakeWindow = makeFakeBrowserWindow();
        const healthReports: unknown[] = [];
        const layer = layerTest({
          window: fakeWindow.window,
          healthReports,
          createCount: yield* Ref.make(0),
          mainWindow: yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none()),
        });
        yield* Effect.gen(function* () {
          const window = yield* DesktopWindow.DesktopWindow;
          yield* window.handleBackendReady(new URL("http://127.0.0.1:3773"));
          const gone = fakeWindow.webContentsListeners.get("render-process-gone")!;
          gone({}, { reason: "clean-exit", exitCode: 0 });
          gone({}, { reason: "oom", exitCode: 137, detail: "/private/file" });
          yield* Effect.yieldNow;
          assert.deepEqual(healthReports, [
            {
              version: 1,
              type: "scientAppHealth",
              component: "renderer",
              failureClass: "resource-exhaustion",
            },
          ]);
        }).pipe(Effect.provide(layer));
      }),
  );
  // SCIENT-FORK:END scient-window

  it.effect(
    "opens and reopens the window without backend readiness when local execution is disabled",
    () =>
      Effect.gen(function* () {
        const fakeWindow = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const layer = layerTest({
          window: fakeWindow.window,
          createCount,
          mainWindow,
          createdWindowOptions: [],
          desktopSettings: {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
          },
        });
        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* desktopWindow.createMainIfBackendReady;
          assert.equal(yield* Ref.get(createCount), 1);
          yield* Ref.set(mainWindow, Option.none());
          yield* desktopWindow.activate;
          assert.equal(yield* Ref.get(createCount), 2);
          yield* Ref.set(mainWindow, Option.none());
          yield* desktopWindow.dispatchMenuAction("new-thread");
          assert.equal(yield* Ref.get(createCount), 3);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("blocks only repeated Cmd+W input before it reaches the native window menu", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const beforeInput = fakeWindow.webContentsListeners.get("before-input-event");
        if (!beforeInput) {
          return yield* Effect.die("before-input-event listener was not registered");
        }

        let prevented = false;
        const event = { preventDefault: () => (prevented = true) };
        const input = {
          type: "keyDown",
          isAutoRepeat: true,
          key: "W",
          meta: true,
          control: false,
          alt: false,
          shift: false,
        };
        beforeInput(event, input);
        assert.isTrue(prevented);

        prevented = false;
        beforeInput(event, { ...input, isAutoRepeat: false });
        assert.isFalse(prevented);

        prevented = false;
        beforeInput(event, { ...input, meta: false });
        assert.isFalse(prevented);
      }).pipe(Effect.provide(layer));
    }),
  );

  // Chromium hands the main window's zoom level down to embedded preview
  // guests, so every app zoom has to put the preview browser back at its own
  // zoom or zooming the UI drags the previewed page with it.
  it.effect("zooms main with a focused popup and reapplies preview zoom", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const popup = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const previewZoomReapplies: number[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        previewZoomReapplies,
        focusedWindow: popup.window,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        yield* desktopWindow.zoomMain("out");
        yield* desktopWindow.zoomMain("out");
        yield* desktopWindow.zoomMain("in");
        yield* desktopWindow.zoomMain("reset");

        assert.deepEqual(
          fakeWindow.setZoomLevel.mock.calls.map(([level]) => level),
          [-0.5, -1, -0.5, 0],
        );
        assert.deepEqual(previewZoomReapplies, [-0.5, -1, -0.5, 0]);
        assert.equal(popup.setZoomLevel.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  // Ctrl+wheel bypasses the menu accelerators, so it has to take the same
  // zoom step, preview restore included, from the window's zoom-changed event.
  it.effect("zooms the app from Ctrl+wheel like the menu does", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const previewZoomReapplies: number[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        previewZoomReapplies,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const zoomChanged = fakeWindow.webContentsListeners.get("zoom-changed");
        if (!zoomChanged) return yield* Effect.die("zoom-changed listener was not registered");
        zoomChanged({}, "in");
        zoomChanged({}, "out");
        zoomChanged({}, "out");

        assert.deepEqual(
          fakeWindow.setZoomLevel.mock.calls.map(([level]) => level),
          [0.5, 0, -0.5],
        );
        assert.deepEqual(previewZoomReapplies, [0.5, 0, -0.5]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reloads and inspects the main window even when a popup has focus", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const popup = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        focusedWindow: popup.window,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        yield* desktopWindow.runMainContentsCommand("reload");
        yield* desktopWindow.runMainContentsCommand("forceReload");
        yield* desktopWindow.runMainContentsCommand("toggleDevTools");

        // SCIENT-FORK:START scient-window
        assert.deepEqual(fakeWindow.send.mock.calls, [
          [MENU_ACTION_CHANNEL, "reload-main"],
          [MENU_ACTION_CHANNEL, "force-reload-main"],
        ]);
        assert.equal(fakeWindow.reload.mock.calls.length, 0);
        assert.equal(fakeWindow.reloadIgnoringCache.mock.calls.length, 0);
        assert.equal(fakeWindow.toggleDevTools.mock.calls.length, 1);
        assert.equal(popup.reload.mock.calls.length, 0);
        assert.equal(popup.reloadIgnoringCache.mock.calls.length, 0);
        assert.equal(popup.toggleDevTools.mock.calls.length, 0);
        assert.equal(popup.send.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "dispatches guarded reload to main rather than a focused popup without revealing it",
    () =>
      Effect.gen(function* () {
        const main = makeFakeBrowserWindow();
        const popup = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(
          Option.some(main.window),
        );
        const onReveal = vi.fn();
        const layer = layerTest({
          window: main.window,
          createCount,
          mainWindow,
          focusedWindow: popup.window,
          onReveal,
        });

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* desktopWindow.runMainContentsCommand("reload");
          yield* desktopWindow.runMainContentsCommand("forceReload");

          assert.deepEqual(main.send.mock.calls, [
            [MENU_ACTION_CHANNEL, "reload-main"],
            [MENU_ACTION_CHANNEL, "force-reload-main"],
          ]);
          assert.equal(popup.send.mock.calls.length, 0);
          assert.equal(main.reload.mock.calls.length, 0);
          assert.equal(main.reloadIgnoringCache.mock.calls.length, 0);
          assert.equal(popup.reload.mock.calls.length, 0);
          assert.equal(popup.reloadIgnoringCache.mock.calls.length, 0);
          assert.equal(onReveal.mock.calls.length, 0);
          assert.equal(yield* Ref.get(createCount), 0);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("applies the size increase to a legacy maximized window before opening", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const mainWindowSizeIncreaseUpdates: (DesktopAppSettings.DesktopWindowBounds | null)[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
        mainWindowSizeIncreaseUpdates,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 760, y: 340, width: 1000, height: 700 },
          mainWindowMaximized: true,
          mainWindowSizeIncreaseApplied: false,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.deepEqual(mainWindowSizeIncreaseUpdates, [
          { x: 640, y: 200, width: 1280, height: 840 },
        ]);
        assert.equal(createdWindowOptions[0]?.width, 1280);
        assert.equal(createdWindowOptions[0]?.height, 840);
        assert.equal(createdWindowOptions[0]?.x, 640);
        assert.equal(createdWindowOptions[0]?.y, 200);
        assert.equal(fakeWindow.maximize.mock.calls.length, 0);
        fakeWindow.windowListeners.get("ready-to-show")?.();
        assert.equal(fakeWindow.maximize.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("opens a saved near-full window at the new size once", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const mainWindowNearFullSizeUpdates: (DesktopAppSettings.DesktopWindowBounds | null)[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
        mainWindowNearFullSizeUpdates,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 15, y: 15, width: 1890, height: 1010 },
          mainWindowNearFullSizeApplied: false,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.deepEqual(mainWindowNearFullSizeUpdates, [
          { x: 8, y: 8, width: 1904, height: 1024 },
        ]);
        assert.equal(createdWindowOptions[0]?.width, 1904);
        assert.equal(createdWindowOptions[0]?.height, 1024);
        assert.equal(createdWindowOptions[0]?.x, 8);
        assert.equal(createdWindowOptions[0]?.y, 8);
        // SCIENT-FORK:END scient-window
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not open main or splash windows once quitting has started", () =>
    Effect.gen(function* () {
      const fake = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      yield* Effect.gen(function* () {
        const windows = yield* DesktopWindow.DesktopWindow;
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);

        yield* windows.showConnectingSplash;
        yield* windows.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* windows.activate;
        yield* windows.dispatchMenuAction("open-settings");
        for (const creation of [
          windows.createMain,
          windows.ensureMain,
          windows.revealOrCreateMain,
        ]) {
          assert.isTrue(Exit.isFailure(yield* Effect.exit(creation)));
        }

        assert.equal(yield* Ref.get(createCount), 0);
        assert.isTrue(Option.isNone(yield* Ref.get(mainWindow)));
        assert.equal(fake.send.mock.calls.length, 0);
      }).pipe(Effect.provide(layerTest({ window: fake.window, createCount, mainWindow })));
    }),
  );

  it.effect.each(["main", "splash"] as const)(
    "destroys a %s window when quit races native creation without loading or revealing it",
    (kind) =>
      Effect.gen(function* () {
        const fake = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const creationStarted = yield* Deferred.make<void>();
        const releaseCreation = yield* Deferred.make<void>();
        const reveal = vi.fn();
        const layer = layerTest({
          window: fake.window,
          createCount,
          mainWindow,
          onWindowCreate: Deferred.succeed(creationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCreation)),
          ),
          destroyAll: Effect.sync(() => fake.isDestroyed.mockReturnValue(true)),
          onReveal: reveal,
        });

        yield* Effect.gen(function* () {
          const windows = yield* DesktopWindow.DesktopWindow;
          const state = yield* DesktopState.DesktopState;
          const fiber = yield* (
            kind === "splash"
              ? windows.showConnectingSplash
              : windows.handleBackendReady(new URL("http://127.0.0.1:3773"))
          ).pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(creationStarted);
          yield* Ref.set(state.quitting, true);
          yield* Deferred.succeed(releaseCreation, undefined);
          assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)));
          assert.equal(yield* Ref.get(createCount), 1);
          assert.isTrue(fake.window.isDestroyed());
          assert.isTrue(Option.isNone(yield* Ref.get(mainWindow)));
          assert.equal(fake.loadURL.mock.calls.length, 0);
          assert.equal(fake.openDevTools.mock.calls.length, 0);
          assert.equal(reveal.mock.calls.length, 0);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect.each(["backend ready", "activation", "renderer event"] as const)(
    "quietly cancels %s when quit races preview cleanup",
    (entry) =>
      Effect.gen(function* () {
        const fake = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const previewStarted = yield* Deferred.make<void>();
        const releasePreview = yield* Deferred.make<void>();
        const reveal = vi.fn();
        const warnings: unknown[] = [];
        const logger = Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn" || logLevel === "Error") warnings.push(message);
        });
        const layer = layerTest({
          window: fake.window,
          createCount,
          mainWindow,
          desktopSettings: {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
          },
          setPreviewMainWindow: () =>
            Deferred.succeed(previewStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releasePreview)),
            ),
          destroyAll: Effect.sync(() => fake.isDestroyed.mockReturnValue(true)),
          onReveal: reveal,
        });

        yield* Effect.gen(function* () {
          const windows = yield* DesktopWindow.DesktopWindow;
          const state = yield* DesktopState.DesktopState;
          const creation =
            entry === "backend ready"
              ? windows.handleBackendReady(new URL("http://127.0.0.1:3773"))
              : entry === "activation"
                ? windows.activate
                : windows.dispatchMenuAction("open-settings");
          const fiber = yield* creation.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(previewStarted);
          yield* Ref.set(state.quitting, true);
          // Cover both an already-destroyed window and one shutdown has yet to destroy.
          fake.isDestroyed.mockReturnValue(entry !== "backend ready");
          yield* Deferred.succeed(releasePreview, undefined);

          assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)));
          assert.isTrue(fake.window.isDestroyed());
          assert.isTrue(Option.isNone(yield* Ref.get(mainWindow)));
          assert.equal(fake.loadURL.mock.calls.length, 0);
          assert.equal(fake.openDevTools.mock.calls.length, 0);
          assert.equal(fake.send.mock.calls.length, 0);
          assert.equal(reveal.mock.calls.length, 0);
          assert.deepEqual(warnings, []);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(layer, Logger.layer([logger], { mergeWithExisting: false })),
          ),
        );
      }),
  );

  it.effect("persists normal bounds and state for a maximized window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.isMaximized.mockReturnValue(true);
      fakeWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 220, y: 140, width: 1380, height: 920 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const mainWindowMaximizedUpdates: boolean[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        mainWindowMaximizedUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("window close listener was not registered");
        }
        close();
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 220, y: 140, width: 1380, height: 920 }]);
        assert.deepEqual(mainWindowMaximizedUpdates, [true]);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("preserves unrestorable bounds until the user changes the window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 2040, y: 80, width: 1320, height: 880 },
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        const move = fakeWindow.windowListeners.get("move");
        if (!close || !move) {
          return yield* Effect.die("window lifecycle listeners were not registered");
        }

        close();
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, []);

        fakeWindow.getBounds.mockReturnValue({ x: 80, y: 60, width: 1280, height: 840 });
        move();
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 80, y: 60, width: 1280, height: 840 }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("flushes normal bounds when minimized before the debounce completes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: -32_000, y: -32_000, width: 160, height: 28 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 180, y: 120, width: 1440, height: 960 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(250);
        fakeWindow.isMinimized.mockReturnValue(true);

        yield* desktopWindow.flushMainWindowBounds;

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 180, y: 120, width: 1440, height: 960 }]);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("persists the current main window bounds before the window closes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: 240, y: 160, width: 1410, height: 930 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const writeStarted = yield* Deferred.make<void>();
      const allowWrite = yield* Deferred.make<void>();
      const flushCompleted = yield* Deferred.make<void>();
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        beforeMainWindowBoundsUpdate: () =>
          Deferred.succeed(writeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowWrite)),
            Effect.asVoid,
          ),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("window close listener was not registered");
        }
        close();
        yield* Deferred.await(writeStarted);
        fakeWindow.isDestroyed.mockReturnValue(true);

        const flushFiber = yield* desktopWindow.flushMainWindowBounds.pipe(
          Effect.andThen(Deferred.succeed(flushCompleted, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(flushCompleted));

        yield* Deferred.succeed(allowWrite, undefined);
        yield* Fiber.join(flushFiber);
        assert.isTrue(yield* Deferred.isDone(flushCompleted));

        assert.deepEqual(mainWindowBoundsUpdates, [
          {
            x: 240,
            y: 160,
            width: 1410,
            height: 930,
          },
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("opens safe off-origin renderer navigations in the system browser", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openedExternalUrls: unknown[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        openedExternalUrls,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const willNavigate = fakeWindow.webContentsListeners.get("will-navigate");
        if (!willNavigate) {
          return yield* Effect.die("will-navigate listener was not registered");
        }
        let prevented = false;
        // SCIENT-FORK:START scient-window
        willNavigate(
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          "scient-next-dev://app/settings/connections",
        );
        yield* Effect.promise(() => Promise.resolve());
        assert.isFalse(prevented);
        assert.deepEqual(openedExternalUrls, []);
        // SCIENT-FORK:END scient-window
        willNavigate(
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          "https://accounts.microsoft.com/oauth",
        );
        yield* Effect.promise(() => Promise.resolve());

        assert.isTrue(prevented);
        assert.deepEqual(openedExternalUrls, ["https://accounts.microsoft.com/oauth"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "retries opening the real main on activate when a failed post-readiness open left only the splash",
    () =>
      Effect.gen(function* () {
        const splash = makeFakeBrowserWindow();
        const main = makeFakeBrowserWindow();
        const scenario = yield* makeSplashScenario([splash.window, null, main.window]);

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;

          yield* desktopWindow.showConnectingSplash;
          assert.equal(yield* Ref.get(scenario.createCalls), 1);

          const readyExit = yield* Effect.exit(
            desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773")),
          );
          assert.equal(readyExit._tag, "Failure");
          assert.equal(yield* Ref.get(scenario.createCalls), 2);
          assert.isTrue(Option.isNone(yield* Ref.get(scenario.mainWindow)));

          yield* desktopWindow.activate;
          assert.equal(yield* Ref.get(scenario.createCalls), 3);
          const registeredMain = yield* Ref.get(scenario.mainWindow);
          assert.isTrue(Option.isSome(registeredMain));
          assert.equal(Option.getOrThrow(registeredMain), main.window);
        }).pipe(Effect.provide(scenario.layer));
      }),
  );

  it.effect("delivers capture completion and late errors without taking focus back", () =>
    Effect.gen(function* () {
      const operations: Array<string> = [];
      let foreground = "Discord";
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.send.mockImplementation(() => {
        operations.push("send");
      });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        onReveal: () => {
          foreground = "T3 Code";
          operations.push("reveal");
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* desktopWindow.dispatchSnapShotEvent({ type: "started", id: captureOne });
        assert.equal(foreground, "T3 Code");
        foreground = "Explorer";
        yield* desktopWindow.dispatchSnapShotEvent({ type: "ready", id: captureOne });
        yield* desktopWindow.dispatchSnapShotEvent({ type: "failed", id: captureTwo });

        assert.equal(foreground, "Explorer");
        assert.deepEqual(operations, ["send", "reveal", "send", "send"]);
        assert.deepEqual(fakeWindow.send.mock.calls, [
          [SNAP_SHOT_EVENT_CHANNEL, { type: "started", id: captureOne }],
          [SNAP_SHOT_EVENT_CHANNEL, { type: "ready", id: captureOne }],
          [SNAP_SHOT_EVENT_CHANNEL, { type: "failed", id: captureTwo }],
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not reopen a closed main window for a completed capture", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const onReveal = vi.fn();
      const layer = layerTest({ window: fakeWindow.window, createCount, mainWindow, onReveal });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        fakeWindow.isDestroyed.mockReturnValue(true);
        yield* Ref.set(mainWindow, Option.none());
        yield* desktopWindow.dispatchSnapShotEvent({ type: "ready", id: captureOne });

        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(fakeWindow.send.mock.calls.length, 0);
        assert.equal(onReveal.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );
});
