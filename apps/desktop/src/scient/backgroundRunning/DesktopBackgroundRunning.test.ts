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
import type * as DesktopUpdateFacts from "../updateOutcomes/DesktopUpdateFacts.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopBackgroundFacts from "./DesktopBackgroundFacts.ts";
import * as DesktopBackgroundRunning from "./DesktopBackgroundRunning.ts";

interface Scenario {
  readonly platform?: NodeJS.Platform;
  /** The stored choice; `null` is nothing stored. Defaults to on. */
  readonly keepRunningInBackground?: boolean | null;
  /** Why the tray could not be shown, when it could not. */
  readonly trayFailure?: DesktopBackgroundFacts.TrayFailure;
}

interface RecordedFact {
  readonly name: string;
  readonly properties: DesktopUpdateFacts.DesktopUpdateFactProperties;
}

const setup = Effect.fn("test.setup")(function* (scenario: Scenario = {}) {
  const platform = scenario.platform ?? "win32";
  const trays: Array<DesktopBackgroundRunning.BackgroundTrayActions | null> = [];
  const recorded: Array<RecordedFact> = [];
  const appListeners = new Map<string, (...args: ReadonlyArray<unknown>) => void>();
  const activations = yield* Ref.make<ReadonlyArray<DesktopBackgroundFacts.ReturnVia>>([]);
  const activated = yield* Deferred.make<void>();
  const quitRequested = yield* Deferred.make<void>();
  const context = yield* Layer.build(
    Layer.effect(
      DesktopBackgroundRunning.DesktopBackgroundRunning,
      DesktopBackgroundRunning.make((actions) =>
        Effect.sync(() => {
          trays.push(actions);
          return actions === null ? null : (scenario.trayFailure ?? null);
        }),
      ),
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
            platform,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
          Layer.effect(
            DesktopBackgroundFacts.DesktopBackgroundFacts,
            DesktopBackgroundFacts.make({
              platform,
              record: (name, properties) =>
                Effect.sync(() => void recorded.push({ name, properties })),
            }),
          ),
          Layer.mock(DesktopWindow.DesktopWindow, {
            activate: Effect.gen(function* () {
              const via = yield* DesktopBackgroundFacts.CurrentReturnVia;
              yield* Ref.update(activations, (vias) => [...vias, via]);
              yield* Deferred.succeed(activated, undefined);
            }),
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
    facts: yield* provide(DesktopBackgroundFacts.DesktopBackgroundFacts),
    trays,
    recorded,
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

const events = (recorded: ReadonlyArray<RecordedFact>) =>
  recorded.filter((fact) => fact.name === "app.background.event").map((fact) => fact.properties);

describe("DesktopBackgroundRunning", () => {
  it.effect("the switch saves the setting, shows or removes the tray and reports the change", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      assert.isNotNull(harness.trays.at(-1));
      yield* harness.background.setEnabled(false);
      assert.isFalse((yield* harness.settings.get).keepRunningInBackground);
      assert.isNull(harness.trays.at(-1));
      yield* harness.background.setEnabled(true);
      assert.isTrue((yield* harness.settings.get).keepRunningInBackground);
      assert.isNotNull(harness.trays.at(-1));
      // Saving the value already stored is no change.
      yield* harness.background.setEnabled(true);
      assert.deepEqual(events(harness.recorded), [
        { kind: "setting-changed", platform: "windows", enabled: false, previousSetBy: "person" },
        { kind: "setting-changed", platform: "windows", enabled: true, previousSetBy: "person" },
      ]);
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
    ["win32", "windows", false],
    ["linux", "linux", false],
    ["darwin", "macos", true],
  ] as const)(
    "with nothing stored on %s the switch reads off or on, no tray shows, and the summary says so",
    ([platform, analyticsPlatform, on]) =>
      Effect.gen(function* () {
        const harness = yield* setup({ platform, keepRunningInBackground: null });
        assert.isNull(harness.trays.at(-1));
        assert.equal(yield* harness.readSwitch, on);
        assert.deepEqual(harness.recorded, [
          {
            name: "app.background.summary",
            properties: {
              reason: "launch",
              platform: analyticsPlatform,
              enabled: on,
              setBy: "default",
            },
          },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "turning it on with nothing stored shows the tray and reports the default it left",
    () =>
      Effect.gen(function* () {
        const harness = yield* setup({ platform: "linux", keepRunningInBackground: null });
        yield* harness.background.setEnabled(true);
        assert.isNotNull(harness.trays.at(-1));
        assert.deepEqual(events(harness.recorded), [
          { kind: "setting-changed", platform: "linux", enabled: true, previousSetBy: "default" },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("reports a tray that cannot be shown", () =>
    Effect.gen(function* () {
      const harness = yield* setup({ platform: "linux", trayFailure: "no-icon" });
      assert.deepEqual(events(harness.recorded), [
        { kind: "tray-failed", platform: "linux", reason: "no-icon" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("removes the tray when the app shuts down", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.scoped(setup());
      assert.isNull(harness.trays.at(-1));
    }),
  );

  it.effect("the tray opens Scient and quits it completely, and says it was the tray", () =>
    Effect.gen(function* () {
      const { trays, activated, activations, quitRequested, facts, recorded } = yield* setup();
      const tray = trays.at(-1);
      assert.isDefined(tray);
      tray?.open();
      yield* Deferred.await(activated);
      assert.deepEqual(yield* Ref.get(activations), ["tray"]);
      yield* facts.windowlessStarted;
      tray?.quit();
      yield* Deferred.await(quitRequested);
      yield* facts.quitDecided("none");
      assert.deepEqual(events(recorded), [
        {
          kind: "quit",
          platform: "windows",
          via: "tray",
          quitPrompt: "none",
          windowlessBucket: "under-1m",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("launching Scient again opens a window when none is open, as a second launch", () =>
    Effect.gen(function* () {
      const { appListeners, state, activated, activations } = yield* setup();
      yield* Ref.set(state.background, true);
      appListeners.get("second-instance")?.({}, ["/app/Scient"]);
      yield* Deferred.await(activated);
      assert.deepEqual(yield* Ref.get(activations), ["second-launch"]);
    }).pipe(Effect.scoped),
  );

  it.effect("launching Scient again leaves an open window to the existing handler", () =>
    Effect.gen(function* () {
      const { appListeners, activations } = yield* setup();
      appListeners.get("second-instance")?.({}, ["/app/Scient"]);
      yield* Effect.yieldNow;
      assert.deepEqual(yield* Ref.get(activations), []);
    }).pipe(Effect.scoped),
  );
});
