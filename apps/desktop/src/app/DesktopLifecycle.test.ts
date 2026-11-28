import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as HostProcess from "@t3tools/shared/HostProcess";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
// SCIENT-FORK:START — Scient background running.
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopBackgroundFacts from "../scient/backgroundRunning/DesktopBackgroundFacts.ts";
import { vi } from "vite-plus/test";

const quitGuard = vi.hoisted(() => ({
  prompt: "none" as "none" | "confirmed" | "cancelled",
  sources: [] as Array<"reported" | "read">,
  /** While set, the check waits on it, as a person deciding in the dialog. */
  gate: undefined as Promise<void> | undefined,
}));
vi.mock("../scient/quitGuard/quitGuard.ts", () => ({
  confirmQuitStopsRunningWork: async (source: "reported" | "read") => {
    quitGuard.sources.push(source);
    await quitGuard.gate;
    return quitGuard.prompt;
  },
}));

/** Background facts the lifecycle records, kept in memory. */
function layerBackgroundFacts(
  platform: NodeJS.Platform,
  recorded: Array<Readonly<Record<string, string | number | boolean>>>,
  onRecord: Effect.Effect<void> = Effect.void,
) {
  return Layer.effect(
    DesktopBackgroundFacts.DesktopBackgroundFacts,
    DesktopBackgroundFacts.make({
      platform,
      record: (_name, properties) =>
        Effect.sync(() => void recorded.push(properties)).pipe(Effect.andThen(onRecord)),
    }),
  );
}
// SCIENT-FORK:END

function layerElectronApp(
  appListeners: Map<string, (...args: readonly unknown[]) => void>,
  quit: Effect.Effect<void> = Effect.void,
  exit: (code: number) => Effect.Effect<void> = () => Effect.void,
  relaunch: (options: Electron.RelaunchOptions) => Effect.Effect<void> = () => Effect.void,
) {
  const registerListener = (eventName: string, listener: (...args: readonly unknown[]) => void) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        appListeners.set(eventName, listener);
      }),
      () =>
        Effect.sync(() => {
          appListeners.delete(eventName);
        }),
    ).pipe(Effect.asVoid);

  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    // SCIENT-FORK:START scient-branding
    name: Effect.succeed("Scient"),
    // SCIENT-FORK:END scient-branding
    systemLocale: Effect.succeed("en-US"),
    preferredSystemLanguages: Effect.succeed(["en-US"]),
    whenReady: Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    quit,
    exit,
    relaunch,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: (listener) => registerListener("before-quit-for-update", listener),
    on: (eventName, listener) =>
      registerListener(eventName, listener as unknown as (...args: readonly unknown[]) => void),
  } satisfies ElectronApp.ElectronApp["Service"]);
}

const layerElectronTheme = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
});

function layerElectronWindow(
  destroyAll: Effect.Effect<void> = Effect.void,
  // SCIENT-FORK:START — a cancelled Quit reads whether a window is open.
  currentMainOrFirst: Effect.Effect<Option.Option<Electron.BrowserWindow>> = Effect.die(
    "unexpected current window read",
  ),
  // SCIENT-FORK:END
) {
  return Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window creation"),
    main: Effect.die("unexpected main window read"),
    // SCIENT-FORK:START — several app windows share one desktop process.
    appWindows: Effect.die("unexpected app window read"),
    // SCIENT-FORK:END
    // SCIENT-FORK: a cancelled Quit reads whether a window is open.
    currentMainOrFirst,
    focusedMainOrFirst: Effect.die("unexpected focused window read"),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll,
    syncAllAppearance: () => Effect.void,
  });
}

function layerDesktopWindow(
  input: {
    readonly activate?: Effect.Effect<void>;
    readonly flushMainWindowBounds?: Effect.Effect<void>;
    // SCIENT-FORK: a cancelled Quit shows the connecting splash while the backend is down.
    readonly showConnectingSplash?: Effect.Effect<void>;
  } = {},
) {
  return Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window creation"),
    ensureMain: Effect.die("unexpected window creation"),
    revealOrCreateMain: Effect.die("unexpected window creation"),
    activate: input.activate ?? Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: input.showConnectingSplash ?? Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: input.flushMainWindowBounds ?? Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: () => Effect.void,
    dispatchSnapShotEvent: () => Effect.void,
    zoomMain: () => Effect.void,
    runMainContentsCommand: () => Effect.void,
    syncAppearance: Effect.void,
    // SCIENT-FORK:START — several app windows share one desktop process.
    openNewWindow: () => Effect.die("unexpected window creation"),
    // SCIENT-FORK:END
  });
}

describe("DesktopLifecycle", () => {
  it.effect.each(["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "lets the updater's quit event proceed on %s",
    (platform) => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let windowsDestroyed = false;
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
        appImagePath: Option.none(),
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(
          layerElectronWindow(
            Effect.sync(() => {
              windowsDestroyed = true;
            }),
          ),
        ),
        Layer.provideMerge(layerDesktopWindow()),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
        // SCIENT-FORK: Scient background running.
        Layer.provideMerge(DesktopAppSettings.layerTest()),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();
          yield* Effect.yieldNow;

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );
          assert.isTrue(windowsDestroyed);

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    },
  );

  it.effect("destroys windows before waiting for backend shutdown", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const shutdownRequested = yield* Deferred.make<void>();
      const allowShutdown = yield* Deferred.make<void>();
      const quitRequested = yield* Deferred.make<void>();
      const events: string[] = [];

      const quit = Effect.sync(() => {
        events.push("quit");
      }).pipe(Effect.andThen(Deferred.succeed(quitRequested, undefined)), Effect.asVoid);
      const destroyAll = Effect.sync(() => {
        events.push("destroy");
      });
      const flushMainWindowBounds = Effect.sync(() => {
        events.push("flush");
      });

      const layerDesktopShutdown = Layer.succeed(DesktopShutdown.DesktopShutdown, {
        request: Effect.sync(() => {
          events.push("request");
        }).pipe(Effect.andThen(Deferred.succeed(shutdownRequested, undefined)), Effect.asVoid),
        awaitRequest: Deferred.await(shutdownRequested),
        markComplete: Deferred.succeed(allowShutdown, undefined).pipe(Effect.asVoid),
        awaitComplete: Deferred.await(allowShutdown),
        isComplete: Deferred.isDone(allowShutdown),
      });

      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners, quit)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow(destroyAll)),
        Layer.provideMerge(layerDesktopWindow({ flushMainWindowBounds })),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(layerDesktopShutdown),
        Layer.provideMerge(DesktopState.layer),
        // SCIENT-FORK: Scient background running.
        Layer.provideMerge(DesktopAppSettings.layerTest()),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          const event = { preventDefault: () => undefined } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          yield* Deferred.await(shutdownRequested);
          const eventsBeforeCleanup = [...events];
          yield* Deferred.succeed(allowShutdown, undefined);
          yield* Deferred.await(quitRequested);

          assert.deepEqual(eventsBeforeCleanup, ["flush", "destroy", "request"]);
          assert.deepEqual(events, ["flush", "destroy", "request", "quit"]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("relaunches without the app link that launched it", () =>
    Effect.gen(function* () {
      const relaunched = yield* Deferred.make<Electron.RelaunchOptions>();
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "linux",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(
          layerElectronApp(
            new Map(),
            Effect.void,
            () => Effect.void,
            (options) => Deferred.succeed(relaunched, options).pipe(Effect.asVoid),
          ),
        ),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow()),
        Layer.provideMerge(layerDesktopWindow()),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
        // SCIENT-FORK: Scient background running.
        Layer.provideMerge(DesktopAppSettings.layerTest()),
      );

      const options = yield* Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        yield* (yield* DesktopShutdown.DesktopShutdown).markComplete;
        yield* lifecycle.relaunch("network access changed");
        return yield* Deferred.await(relaunched);
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(HostProcess.ExecutablePath, "/opt/T3 Code/t3code"),
        Effect.provideService(HostProcess.Arguments, [
          "/opt/T3 Code/t3code",
          "--no-sandbox",
          "SCIENT://pair?token=spent",
          "scient://new?prompt=hello",
        ]),
      );

      assert.deepEqual(options, { execPath: "/opt/T3 Code/t3code", args: ["--no-sandbox"] });
    }),
  );

  it.effect("exits on a repeated quit only once shutdown has stalled", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const exitCodes: number[] = [];
      const exit = (code: number) =>
        Effect.sync(() => {
          exitCodes.push(code);
        });
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners, Effect.void, exit)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow()),
        Layer.provideMerge(layerDesktopWindow()),
        Layer.provideMerge(layerEnvironment),
        // Nothing marks this shutdown complete, so it stays pending.
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
        // SCIENT-FORK: Scient background running.
        Layer.provideMerge(DesktopAppSettings.layerTest()),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          let prevented = 0;
          const event = {
            preventDefault: () => {
              prevented += 1;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);
          appListeners.get("before-quit")?.(event);
          yield* TestClock.adjust("9999 millis");
          appListeners.get("before-quit")?.(event);
          assert.deepEqual(
            exitCodes,
            [],
            "a repeat before the threshold must not cut shutdown short",
          );

          yield* TestClock.adjust("1 millis");
          appListeners.get("before-quit")?.(event);

          assert.deepEqual(exitCodes, [0]);
          assert.equal(prevented, 4);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("ignores app activation while quitting", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let activationCount = 0;
      const activate = Effect.sync(() => {
        activationCount += 1;
      });
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow()),
        Layer.provideMerge(layerDesktopWindow({ activate })),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
        // SCIENT-FORK: Scient background running.
        Layer.provideMerge(DesktopAppSettings.layerTest()),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const state = yield* DesktopState.DesktopState;
          yield* lifecycle.register;
          yield* Ref.set(state.quitting, true);

          appListeners.get("activate")?.();

          assert.equal(activationCount, 0);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  // SCIENT-FORK:START — Scient keeps running in the background.
  const closeLastWindow = Effect.fn("test.closeLastWindow")(function* (
    platform: NodeJS.Platform,
    keepRunningInBackground: boolean | null,
    expectQuit: boolean,
  ) {
    const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
    const quitRequested = yield* Deferred.make<void>();
    const layer = DesktopLifecycle.layer.pipe(
      Layer.provideMerge(
        layerElectronApp(
          appListeners,
          Deferred.succeed(quitRequested, undefined).pipe(Effect.asVoid),
        ),
      ),
      Layer.provideMerge(layerElectronTheme),
      Layer.provideMerge(layerElectronWindow()),
      Layer.provideMerge(layerDesktopWindow()),
      Layer.provideMerge(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform,
          isDevelopment: false,
          appImagePath: Option.none(),
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
      ),
      Layer.provideMerge(DesktopShutdown.layer),
      Layer.provideMerge(DesktopState.layer),
      Layer.provideMerge(
        DesktopAppSettings.layerTest({
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          keepRunningInBackground,
        }),
      ),
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* DesktopLifecycle.DesktopLifecycle).register;
        const state = yield* DesktopState.DesktopState;
        appListeners.get("window-all-closed")?.();
        if (expectQuit) yield* Deferred.await(quitRequested);
        else yield* Effect.yieldNow;
        return {
          background: yield* Ref.get(state.background),
          quit: yield* Deferred.isDone(quitRequested),
        };
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect.each(["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "keeps running hidden after the last window closes on %s",
    (platform) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* closeLastWindow(platform, true, false), {
          background: true,
          quit: false,
        });
      }),
  );

  it.effect.each([
    { platform: "win32", keepRunningInBackground: null, source: "reported" },
    { platform: "linux", keepRunningInBackground: null, source: "reported" },
    { platform: "win32", keepRunningInBackground: false, source: "reported" },
    { platform: "linux", keepRunningInBackground: true, source: "read" },
    { platform: "darwin", keepRunningInBackground: null, source: "read" },
  ] satisfies ReadonlyArray<{
    platform: NodeJS.Platform;
    keepRunningInBackground: boolean | null;
    source: "reported" | "read";
  }>)(
    "Quit reads running work only while background running is in effect: %o",
    ({ platform, keepRunningInBackground, source }) =>
      Effect.gen(function* () {
        const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
        const layer = DesktopLifecycle.layer.pipe(
          Layer.provideMerge(layerElectronApp(appListeners)),
          Layer.provideMerge(layerElectronTheme),
          Layer.provideMerge(layerElectronWindow(Effect.void, Effect.succeedSome({} as never))),
          Layer.provideMerge(layerDesktopWindow()),
          Layer.provideMerge(
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              platform,
              isDevelopment: false,
              appImagePath: Option.none(),
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
          ),
          Layer.provideMerge(DesktopShutdown.layer),
          Layer.provideMerge(DesktopState.layer),
          Layer.provideMerge(
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              keepRunningInBackground,
            }),
          ),
        );
        quitGuard.prompt = "cancelled";
        quitGuard.sources.length = 0;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* (yield* DesktopLifecycle.DesktopLifecycle).register;
            appListeners.get("before-quit")?.({ preventDefault: () => {} } as Electron.Event);
            const settled = Promise.withResolvers<void>();
            setImmediate(settled.resolve);
            yield* Effect.promise(() => settled.promise);
          }),
        ).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.sync(() => (quitGuard.prompt = "none"))),
        );
        assert.deepEqual(quitGuard.sources, [source]);
      }),
  );

  it.effect.each(["win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "quits after the last window closes on %s with background running off",
    (platform) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* closeLastWindow(platform, false, true), {
          background: false,
          quit: true,
        });
      }),
  );

  // Nothing stored: what loading an absent settings file yields.
  it.effect.each(["win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "quits after the last window closes on %s when the person never chose",
    (platform) =>
      Effect.gen(function* () {
        const { keepRunningInBackground } = DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS;
        assert.deepEqual(yield* closeLastWindow(platform, keepRunningInBackground, true), {
          background: false,
          quit: true,
        });
      }),
  );

  it.effect("keeps running after the last window closes on macOS when the person never chose", () =>
    Effect.gen(function* () {
      const { keepRunningInBackground } = DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS;
      assert.deepEqual(yield* closeLastWindow("darwin", keepRunningInBackground, false), {
        background: true,
        quit: false,
      });
    }),
  );

  it.effect.each([
    { platform: "win32", background: false, primaryReady: true, shows: "main" },
    { platform: "win32", background: false, primaryReady: false, shows: "splash" },
    { platform: "linux", background: false, primaryReady: false, shows: "splash" },
    { platform: "win32", background: true, primaryReady: false, shows: "nothing" },
    { platform: "darwin", background: false, primaryReady: false, shows: "nothing" },
  ] satisfies ReadonlyArray<{
    platform: NodeJS.Platform;
    background: boolean;
    primaryReady: boolean;
    shows: "main" | "splash" | "nothing";
  }>)(
    "a Quit cancelled with no window open shows one at once only where nothing else would: %o",
    ({ platform, background, primaryReady, shows }) =>
      Effect.gen(function* () {
        const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
        const shown = yield* Deferred.make<"main" | "splash">();
        const window = {} as Electron.BrowserWindow;
        let open = Option.none<Electron.BrowserWindow>();
        const showWindow = (kind: "main" | "splash") =>
          Effect.sync(() => {
            open = Option.some(window);
          }).pipe(Effect.andThen(Deferred.succeed(shown, kind)), Effect.asVoid);
        const recorded: Array<Readonly<Record<string, string | number | boolean>>> = [];
        const reported = yield* Deferred.make<void>();
        const layer = DesktopLifecycle.layer.pipe(
          Layer.provideMerge(layerElectronApp(appListeners)),
          Layer.provideMerge(layerElectronTheme),
          Layer.provideMerge(
            layerElectronWindow(
              Effect.void,
              Effect.sync(() => open),
            ),
          ),
          Layer.provideMerge(
            layerDesktopWindow({
              // Activation opens the main window only once the primary backend is ready.
              activate: primaryReady ? showWindow("main") : Effect.void,
              showConnectingSplash: showWindow("splash"),
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              platform,
              appImagePath: Option.none(),
              isDevelopment: false,
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
          ),
          Layer.provideMerge(DesktopShutdown.layer),
          Layer.provideMerge(DesktopState.layer),
          Layer.provideMerge(DesktopAppSettings.layerTest()),
          Layer.provideMerge(
            layerBackgroundFacts(
              platform,
              recorded,
              Deferred.succeed(reported, undefined).pipe(Effect.asVoid),
            ),
          ),
        );
        quitGuard.prompt = "cancelled";
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* (yield* DesktopLifecycle.DesktopLifecycle).register;
            yield* Ref.set((yield* DesktopState.DesktopState).background, background);
            appListeners.get("before-quit")?.({ preventDefault: () => {} } as Electron.Event);
            if (shows === "nothing") {
              const settled = Promise.withResolvers<void>();
              setImmediate(settled.resolve);
              yield* Effect.promise(() => settled.promise);
              assert.isFalse(yield* Deferred.isDone(shown));
            } else {
              assert.equal(yield* Deferred.await(shown), shows);
            }
            // The splash is the fallback analytics counts; nothing else here is reported.
            if (shows === "splash") {
              yield* Deferred.await(reported);
              assert.deepEqual(recorded, [
                { kind: "splash-fallback", platform: platform === "win32" ? "windows" : platform },
              ]);
            } else {
              assert.deepEqual(recorded, []);
            }
          }),
        ).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.sync(() => (quitGuard.prompt = "none"))),
        );
      }),
  );

  it.effect(
    "the last window closing begins a windowless period that a cancelled Quit reports",
    () =>
      Effect.gen(function* () {
        const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
        const recorded: Array<Readonly<Record<string, string | number | boolean>>> = [];
        const reported = yield* Deferred.make<void>();
        const layer = DesktopLifecycle.layer.pipe(
          Layer.provideMerge(layerElectronApp(appListeners)),
          Layer.provideMerge(layerElectronTheme),
          Layer.provideMerge(layerElectronWindow()),
          Layer.provideMerge(layerDesktopWindow()),
          Layer.provideMerge(
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              platform: "win32",
              appImagePath: Option.none(),
              isDevelopment: false,
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
          ),
          Layer.provideMerge(DesktopShutdown.layer),
          Layer.provideMerge(DesktopState.layer),
          Layer.provideMerge(
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              keepRunningInBackground: true,
            }),
          ),
          Layer.provideMerge(
            layerBackgroundFacts(
              "win32",
              recorded,
              Deferred.succeed(reported, undefined).pipe(Effect.asVoid),
            ),
          ),
        );
        quitGuard.prompt = "cancelled";
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* (yield* DesktopLifecycle.DesktopLifecycle).register;
            appListeners.get("window-all-closed")?.();
            yield* Effect.yieldNow;
            appListeners.get("before-quit")?.({ preventDefault: () => {} } as Electron.Event);
            yield* Deferred.await(reported);
          }),
        ).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.sync(() => (quitGuard.prompt = "none"))),
        );
        assert.deepEqual(recorded, [
          {
            kind: "quit",
            platform: "windows",
            via: "other",
            quitPrompt: "cancelled",
            windowlessBucket: "under-1m",
          },
        ]);
      }),
  );

  it.effect("a tray Quit ignored while another Quit asks does not mark the next Quit", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const recorded: Array<Readonly<Record<string, string | number | boolean>>> = [];
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow(Effect.void, Effect.succeedSome({} as never))),
        Layer.provideMerge(layerDesktopWindow()),
        Layer.provideMerge(
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            platform: "win32",
            appImagePath: Option.none(),
            isDevelopment: false,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
        Layer.provideMerge(
          DesktopAppSettings.layerTest({
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            keepRunningInBackground: true,
          }),
        ),
        Layer.provideMerge(layerBackgroundFacts("win32", recorded)),
      );
      const settle = Effect.promise(() => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setImmediate(resolve);
        return promise;
      });
      const deciding = Promise.withResolvers<void>();
      quitGuard.prompt = "cancelled";
      quitGuard.gate = deciding.promise;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* DesktopLifecycle.DesktopLifecycle).register;
          const facts = yield* DesktopBackgroundFacts.DesktopBackgroundFacts;
          const quit = () =>
            appListeners.get("before-quit")?.({ preventDefault: () => {} } as Electron.Event);
          yield* facts.windowlessStarted;
          yield* facts.trayQuitChosen;
          quit();
          yield* settle;
          // The tray again while the first Quit's dialog is open: this request is ignored.
          yield* facts.trayQuitChosen;
          quit();
          yield* settle;
          deciding.resolve();
          yield* settle;
          quitGuard.gate = undefined;
          quit();
          yield* settle;
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            quitGuard.prompt = "none";
            quitGuard.gate = undefined;
          }),
        ),
      );
      assert.deepEqual(
        recorded.map((fact) => fact.via),
        ["tray", "other"],
      );
    }),
  );

  it.effect("the Dock icon asks for a window as the Dock", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const via = yield* Deferred.make<DesktopBackgroundFacts.ReturnVia>();
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow()),
        Layer.provideMerge(
          layerDesktopWindow({
            activate: Effect.gen(function* () {
              yield* Deferred.succeed(via, yield* DesktopBackgroundFacts.CurrentReturnVia);
            }),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            platform: "darwin",
            appImagePath: Option.none(),
            isDevelopment: false,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
        Layer.provideMerge(DesktopAppSettings.layerTest()),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* DesktopLifecycle.DesktopLifecycle).register;
          appListeners.get("activate")?.();
          assert.equal(yield* Deferred.await(via), "dock");
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
  // SCIENT-FORK:END
});
