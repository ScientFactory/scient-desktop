// SCIENT-OWNED: Scient keeps running in the background (Settings → General).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Electron from "electron";
import { msg } from "gt-i18n";

import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import { m } from "../../i18n/messages.ts";
import {
  GET_KEEP_RUNNING_IN_BACKGROUND_CHANNEL,
  SET_KEEP_RUNNING_IN_BACKGROUND_CHANNEL,
} from "../../ipc/channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../../ipc/DesktopIpc.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopBackgroundFacts from "./DesktopBackgroundFacts.ts";
import { backgroundRunningInEffect } from "./backgroundRunningInEffect.ts";

export interface BackgroundTrayActions {
  readonly open: () => void;
  readonly quit: () => void;
}

/** The Windows/Linux tray icon; `null` removes it. Fails soft, saying why no tray shows. */
export type SetTray = (
  actions: BackgroundTrayActions | null,
) => Effect.Effect<DesktopBackgroundFacts.TrayFailure | null>;

class DesktopTrayError extends Schema.TaggedError<DesktopTrayError>()("DesktopTrayError", {
  cause: Schema.Defect(),
}) {}

export class DesktopBackgroundRunning extends Context.Service<
  DesktopBackgroundRunning,
  {
    /** Once, after Electron is ready. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly setEnabled: (
      enabled: boolean,
    ) => Effect.Effect<void, DesktopAppSettings.DesktopSettingsWriteError>;
  }
>()("@t3tools/desktop/scient/backgroundRunning/DesktopBackgroundRunning") {}

export const make = Effect.fn("DesktopBackgroundRunning.make")(function* (setTray: SetTray) {
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const state = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const facts = yield* DesktopBackgroundFacts.DesktopBackgroundFacts;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  const activateVia = (via: DesktopBackgroundFacts.ReturnVia) =>
    desktopWindow.activate.pipe(
      Effect.provideService(DesktopBackgroundFacts.CurrentReturnVia, via),
      Effect.ignoreCause({ log: true }),
    );
  const trayActions: BackgroundTrayActions = {
    open: () => runFork(activateVia("tray")),
    quit: () => runFork(facts.trayQuitChosen.pipe(Effect.andThen(electronApp.quit))),
  };
  // macOS keeps the Dock icon, which opens and quits Scient already.
  const syncTray = Effect.fn("DesktopBackgroundRunning.syncTray")(function* (enabled: boolean) {
    const failure = yield* setTray(
      enabled && environment.platform !== "darwin" ? trayActions : null,
    );
    if (failure !== null) yield* facts.trayFailed(failure);
  });

  return DesktopBackgroundRunning.of({
    start: Effect.gen(function* () {
      // Base only reveals an open window; with none, launching Scient again must open one.
      yield* electronApp.on("second-instance", () => {
        runFork(
          Ref.get(state.background).pipe(
            Effect.flatMap((background) =>
              background ? activateVia("second-launch") : Effect.void,
            ),
          ),
        );
      });
      // The tray follows background running as this process applies it, not later changes.
      yield* syncTray(
        yield* backgroundRunningInEffect.pipe(
          Effect.provideService(DesktopState.DesktopState, state),
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
          Effect.provideService(DesktopAppSettings.DesktopAppSettings, appSettings),
        ),
      );
      // Summaries report what this start applies: a change of the switch waits for the next start.
      const choiceAtStart = (yield* appSettings.get).keepRunningInBackground;
      yield* facts.summaries(Effect.succeed(choiceAtStart));
      yield* Effect.addFinalizer(() => setTray(null));
    }).pipe(Effect.withSpan("DesktopBackgroundRunning.start")),
    // The choice takes effect at the next start, for window closing, the tray and Accounts alike.
    setEnabled: Effect.fn("DesktopBackgroundRunning.setEnabled")(function* (enabled) {
      const previous = (yield* appSettings.get).keepRunningInBackground;
      const { changed } = yield* appSettings.setKeepRunningInBackground(enabled);
      if (changed) yield* facts.settingChanged({ enabled, previous });
    }),
  });
});

const makeElectronTray = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const iconPaths = yield* (yield* DesktopAssets.DesktopAssets).iconPaths;
  let tray: Electron.Tray | null = null;

  const trayIcon = (): string | Electron.NativeImage | null => {
    if (environment.platform === "win32") return Option.getOrNull(iconPaths.ico);
    if (Option.isNone(iconPaths.png)) return null;
    // A full-size PNG would cross D-Bus to the status notifier host at every update.
    return Electron.nativeImage
      .createFromPath(iconPaths.png.value)
      .resize({ width: 32, height: 32, quality: "best" });
  };

  const setTray: SetTray = (actions) =>
    Effect.try({
      try: (): DesktopBackgroundFacts.TrayFailure | null => {
        if (actions === null) {
          tray?.destroy();
          tray = null;
          return null;
        }
        if (tray !== null) return null;
        const icon = trayIcon();
        if (icon === null) return "no-icon";
        tray = new Electron.Tray(icon);
        tray.setToolTip(environment.displayName);
        tray.setContextMenu(
          Electron.Menu.buildFromTemplate([
            {
              label: m(msg("Open {appName}"), { appName: environment.displayName }),
              click: actions.open,
            },
            { type: "separator" },
            { label: m(msg("Quit completely")), click: actions.quit },
          ]),
        );
        tray.on("click", actions.open);
        return null;
      },
      catch: (cause) => new DesktopTrayError({ cause }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not show the tray icon.", error).pipe(Effect.as("error" as const)),
      ),
    );
  return setTray;
});

export const layer = Layer.effect(
  DesktopBackgroundRunning,
  makeElectronTray.pipe(Effect.flatMap(make)),
);

export const getKeepRunningInBackground = makeSyncIpcMethod({
  channel: GET_KEEP_RUNNING_IN_BACKGROUND_CHANNEL,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.backgroundRunning.get")(function* () {
    const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
    const { platform } = yield* DesktopEnvironment.DesktopEnvironment;
    return DesktopAppSettings.keepsRunningInBackground(settings, platform);
  }),
});

export const setKeepRunningInBackground = makeIpcMethod({
  channel: SET_KEEP_RUNNING_IN_BACKGROUND_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.backgroundRunning.set")(function* (enabled) {
    yield* (yield* DesktopBackgroundRunning).setEnabled(enabled);
  }),
});
