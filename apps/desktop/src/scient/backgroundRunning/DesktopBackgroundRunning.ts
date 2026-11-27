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

export interface BackgroundTrayActions {
  readonly open: () => void;
  readonly quit: () => void;
}

/** The Windows/Linux tray icon; `null` removes it. */
export type SetTray = (actions: BackgroundTrayActions | null) => Effect.Effect<void>;

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
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  const trayActions: BackgroundTrayActions = {
    open: () => runFork(desktopWindow.activate.pipe(Effect.ignoreCause({ log: true }))),
    quit: () => runFork(electronApp.quit),
  };
  // macOS keeps the Dock icon, which opens and quits Scient already.
  const syncTray = (enabled: boolean) =>
    setTray(enabled && environment.platform !== "darwin" ? trayActions : null);

  return DesktopBackgroundRunning.of({
    start: Effect.gen(function* () {
      // Base only reveals an open window; with none, launching Scient again must open one.
      yield* electronApp.on("second-instance", () => {
        runFork(
          Ref.get(state.background).pipe(
            Effect.flatMap((background) => (background ? desktopWindow.activate : Effect.void)),
            Effect.ignoreCause({ log: true }),
          ),
        );
      });
      yield* syncTray((yield* appSettings.get).keepRunningInBackground);
      yield* Effect.addFinalizer(() => setTray(null));
    }).pipe(Effect.withSpan("DesktopBackgroundRunning.start")),
    setEnabled: Effect.fn("DesktopBackgroundRunning.setEnabled")(function* (enabled) {
      yield* appSettings.setKeepRunningInBackground(enabled);
      yield* syncTray(enabled);
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
    Effect.sync(() => {
      if (actions === null) {
        tray?.destroy();
        tray = null;
        return;
      }
      if (tray !== null) return;
      const icon = trayIcon();
      if (icon === null) return;
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
    });
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
    return (yield* (yield* DesktopAppSettings.DesktopAppSettings).get).keepRunningInBackground;
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
