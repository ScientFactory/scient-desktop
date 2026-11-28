import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopBackgroundRunning from "./DesktopBackgroundRunning.ts";

interface Scenario {
  readonly platform?: NodeJS.Platform;
  /** The stored choice; `null` is nothing stored. Defaults to on. */
  readonly keepRunningInBackground?: boolean | null;
}

const setup = Effect.fn("test.setup")(function* (scenario: Scenario = {}) {
  const trays: Array<DesktopBackgroundRunning.BackgroundTrayActions | null> = [];
  const appListeners = new Map<string, (...args: ReadonlyArray<unknown>) => void>();
  const activations = yield* Ref.make(0);
  const activated = yield* Deferred.make<void>();
  const quitRequested = yield* Deferred.make<void>();
  const context = yield* Layer.build(
    Layer.effect(
      DesktopBackgroundRunning.DesktopBackgroundRunning,
      DesktopBackgroundRunning.make((actions) => Effect.sync(() => void trays.push(actions))),
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          DesktopAppSettings.layerTest({
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            keepRunningInBackground:
              scenario.keepRunningInBackground === undefined
                ? true
                : scenario.keepRunningInBackground,
          }),
          DesktopState.layer,
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            platform: scenario.platform ?? "win32",
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
          Layer.mock(DesktopWindow.DesktopWindow, {
            activate: Ref.update(activations, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(activated, undefined)),
              Effect.asVoid,
            ),
          }),
          Layer.mock(ElectronApp.ElectronApp, {
            quit: Deferred.succeed(quitRequested, undefined).pipe(Effect.asVoid),
            on: (eventName, listener) =>
              Effect.sync(() => {
                appListeners.set(eventName, listener as (...args: ReadonlyArray<unknown>) => void);
              }),
          }),
        ),
      ),
    ),
  );
  const provide = Effect.provideContext(context);
  const background = yield* provide(DesktopBackgroundRunning.DesktopBackgroundRunning);
  yield* provide(background.start);
  return {
    background,
    state: yield* provide(DesktopState.DesktopState),
    settings: yield* provide(DesktopAppSettings.DesktopAppSettings),
    trays,
    appListeners,
    activations,
    activated,
    quitRequested,
    /** What the Settings switch reads through IPC. */
    readSwitch: provide(
      DesktopBackgroundRunning.getKeepRunningInBackground.handler({} as Electron.IpcMainEvent),
    ),
  };
});

describe("DesktopBackgroundRunning", () => {
  it.effect("the switch saves the setting and shows or removes the tray", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      assert.isNotNull(harness.trays.at(-1));
      yield* harness.background.setEnabled(false);
      assert.isFalse((yield* harness.settings.get).keepRunningInBackground);
      assert.isNull(harness.trays.at(-1));
      yield* harness.background.setEnabled(true);
      assert.isTrue((yield* harness.settings.get).keepRunningInBackground);
      assert.isNotNull(harness.trays.at(-1));
    }).pipe(Effect.scoped),
  );

  it.effect("shows a tray on Windows and Linux only", () =>
    Effect.gen(function* () {
      assert.isNotNull((yield* setup({ platform: "linux" })).trays.at(-1));
      assert.isNull((yield* setup({ platform: "darwin" })).trays.at(-1));
      assert.isNull((yield* setup({ keepRunningInBackground: false })).trays.at(-1));
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    ["win32", false],
    ["linux", false],
    ["darwin", true],
  ] as const)(
    "with nothing stored on %s the Settings switch reads %s and no tray shows",
    ([platform, on]) =>
      Effect.gen(function* () {
        const harness = yield* setup({ platform, keepRunningInBackground: null });
        assert.isNull(harness.trays.at(-1));
        assert.equal(yield* harness.readSwitch, on);
      }).pipe(Effect.scoped),
  );

  it.effect("removes the tray when the app shuts down", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.scoped(setup());
      assert.isNull(harness.trays.at(-1));
    }),
  );

  it.effect("the tray opens Scient and quits it completely", () =>
    Effect.gen(function* () {
      const { trays, activated, quitRequested } = yield* setup();
      const tray = trays.at(-1);
      assert.isDefined(tray);
      tray?.open();
      yield* Deferred.await(activated);
      tray?.quit();
      yield* Deferred.await(quitRequested);
    }).pipe(Effect.scoped),
  );

  it.effect("launching Scient again opens a window when none is open", () =>
    Effect.gen(function* () {
      const { appListeners, state, activated } = yield* setup();
      yield* Ref.set(state.background, true);
      appListeners.get("second-instance")?.({}, ["/app/Scient"]);
      yield* Deferred.await(activated);
    }).pipe(Effect.scoped),
  );

  it.effect("launching Scient again leaves an open window to the existing handler", () =>
    Effect.gen(function* () {
      const { appListeners, activations } = yield* setup();
      appListeners.get("second-instance")?.({}, ["/app/Scient"]);
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(activations), 0);
    }).pipe(Effect.scoped),
  );
});
