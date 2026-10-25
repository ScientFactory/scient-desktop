import { assert, describe, it } from "@effect/vitest";
// SCIENT-FORK:START scient-window-ipc
import * as NodeEvents from "node:events";
// SCIENT-FORK:END scient-window-ipc
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const { focusedWebContents, ownerWindow } = vi.hoisted(() => ({
  focusedWebContents: vi.fn(),
  ownerWindow: vi.fn(),
}));
vi.mock("electron", () => ({
  webContents: { getFocusedWebContents: focusedWebContents },
  BrowserWindow: { fromWebContents: ownerWindow },
}));

import * as DesktopBackendConfiguration from "../../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
// SCIENT-FORK:START scient-window-ipc
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import {
  getLocalEnvironmentBootstraps,
  getRelayTelemetryEnabled,
  getWindowFullscreenState,
  pasteAsText,
  pickProjectFavicon,
  reloadMainWindow,
  revealWindow,
  // SCIENT-FORK:END scient-window-ipc
  probeRemoteEditors,
} from "./window.ts";

const readyWslConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  args: ["-d", "Ubuntu", "--", "node", "/app/bin.mjs"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "0.0.0.0",
    desktopBootstrapToken: "bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: "Ubuntu",
};

const defaultWslInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.BackendInstanceId("wsl:default"),
  label: Effect.succeed("WSL (default distro)"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeedSome(readyWslConfig),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

const backendConfigurationLayer = Layer.succeed(
  DesktopBackendConfiguration.DesktopBackendConfiguration,
  {
    resolvePrimary: Effect.die("unexpected resolvePrimary"),
    resolvePrimaryLabel: Effect.succeed("Windows"),
    resolveWsl: () => Effect.die("unexpected resolveWsl"),
    currentBootstrapToken: Effect.succeed("current-window-token"),
  } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
);

const bootstrapsLayer = (instances: ReadonlyArray<DesktopBackendManager.DesktopBackendInstance>) =>
  Layer.merge(DesktopBackendPool.layerTest([...instances]), backendConfigurationLayer);

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("hands out the current window's token to a backend launched with the secret", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();

      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "current-window-token",
        },
      ]);
    }).pipe(
      Effect.provide(
        bootstrapsLayer([
          {
            ...defaultWslInstance,
            currentConfig: Effect.succeedSome({
              ...readyWslConfig,
              bootstrap: {
                ...readyWslConfig.bootstrap,
                desktopBootstrapSecret: "desktop-secret",
              },
            }),
          },
        ]),
      ),
    ),
  );

  it.effect("publishes a pending bootstrap only while a transient retry is scheduled", () => {
    const retryingConfig: DesktopBackendManager.DesktopBackendStartConfig = {
      ...readyWslConfig,
      preflightFailure: Option.some({
        reason: "WSL probe timed out",
        fatal: false,
        retryLimit: 12,
      }),
    };
    const retryingInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeedSome(retryingConfig),
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 2,
        restartScheduled: true,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (default distro)",
          runningDistro: null,
          httpBaseUrl: null,
          wsBaseUrl: null,
        },
      ]);
    }).pipe(Effect.provide(bootstrapsLayer([retryingInstance])));
  });

  it.effect("omits a bounded transient bootstrap after retries stop", () => {
    const stoppedInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeedSome({
        ...readyWslConfig,
        preflightFailure: Option.some({
          reason: "WSL probe timed out",
          fatal: false,
          retryLimit: 12,
        }),
      }),
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 12,
        restartScheduled: false,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, []);
    }).pipe(Effect.provide(bootstrapsLayer([stoppedInstance])));
  });
});

describe("getRelayTelemetryEnabled", () => {
  // SCIENT-FORK:START scient-window-ipc
  it.effect("keeps relay tracing disabled by Scient policy regardless of ambient opt-in", () =>
    // SCIENT-FORK:END scient-window-ipc
    Effect.gen(function* () {
      assert.isFalse(
        yield* getRelayTelemetryEnabled.handler().pipe(
          Effect.provideService(HostProcess.Environment, {
            T3CODE_TELEMETRY_ENABLED: "false",
          }),
        ),
      );
      // SCIENT-FORK:START scient-window-ipc
      assert.isFalse(
        yield* getRelayTelemetryEnabled
          .handler()
          .pipe(Effect.provideService(HostProcess.Environment, {})),
      );
      assert.isFalse(
        yield* getRelayTelemetryEnabled
          .handler()
          .pipe(
            Effect.provideService(HostProcess.Environment, { T3CODE_TELEMETRY_ENABLED: "true" }),
          ),
      );
    }),
  );
});

describe("reloadMainWindow", () => {
  it.effect("reloads only the requesting main renderer, with the selected cache policy", () => {
    const reload = vi.fn();
    const reloadIgnoringCache = vi.fn();
    const contents = Object.assign(new NodeEvents.EventEmitter(), {
      id: 42,
      isDestroyed: () => false,
      reload,
      reloadIgnoringCache,
      send: vi.fn(),
    });
    const window = {
      webContents: contents,
      isDestroyed: () => false,
    } as unknown as Electron.BrowserWindow;
    return Effect.gen(function* () {
      assert.isFalse(yield* reloadMainWindow.handler(true, { sender: { id: 99 } }));
      assert.equal(reload.mock.calls.length, 0);
      assert.equal(reloadIgnoringCache.mock.calls.length, 0);

      assert.isTrue(yield* reloadMainWindow.handler(false, { sender: { id: 42 } }));
      assert.equal(reload.mock.calls.length, 1);
      contents.emit("did-finish-load");
      assert.equal(contents.listenerCount("will-prevent-unload"), 0);
      assert.isTrue(yield* reloadMainWindow.handler(true, { sender: { id: 42 } }));
      assert.equal(reloadIgnoringCache.mock.calls.length, 1);
      contents.emit("did-start-navigation");
      contents.emit("will-prevent-unload");
      assert.deepEqual(contents.send.mock.calls, [["desktop:reload-blocked"]]);
      assert.equal(contents.listenerCount("will-prevent-unload"), 0);
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeed(Option.some(window)) }),
      ),
    );
  });
});
// SCIENT-FORK:END scient-window-ipc

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "finds remote editors installed without PATH launchers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-remote-editors-" });
      for (const app of ["Cursor", "Visual Studio Code", "WebStorm"]) {
        const executable = path.join(
          home,
          "Applications",
          `${app}.app`,
          app === "WebStorm" ? "Contents/MacOS/webstorm" : "Contents/Resources/app/bin/code",
        );
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(executable, "#!/bin/sh\n");
        yield* fs.chmod(executable, 0o755);
      }
      const editors = yield* probeRemoteEditors.handler(undefined).pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: home,
          PATH: path.join(home, "empty"),
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      assert.include(editors, "cursor");
      assert.include(editors, "vscode");
      assert.include(editors, "webstorm");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// SCIENT-FORK:START scient-window-ipc - fix guards upstream's snap dropped; no other test covers them.
describe("getWindowFullscreenState", () => {
  // regression: 0418301de7 Fix macOS fullscreen titlebar spacing (#4019)
  it.effect("reads the current native window state", () => {
    const window = { isFullScreen: () => true } as Electron.BrowserWindow;

    return Effect.gen(function* () {
      assert.isTrue(yield* getWindowFullscreenState.handler());
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronWindow.ElectronWindow)({
          currentMainOrFirst: Effect.succeedSome(window),
        }),
      ),
    );
  });
});

describe("revealWindow", () => {
  // regression: bb86c24139 fix(desktop): raise the window when a thread notification is clicked … (#12567)
  it.effect("reveals the main window only when it asks", () => {
    const window = { webContents: { id: 42 } } as unknown as Electron.BrowserWindow;
    const reveal = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      yield* revealWindow.handler(undefined, { sender: { id: 99 } });
      assert.equal(reveal.mock.calls.length, 0);
      yield* revealWindow.handler(undefined, { sender: { id: 42 } });
      assert.deepEqual(reveal.mock.calls, [[window]]);
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronWindow.ElectronWindow)({
          main: Effect.succeedSome(window),
          reveal,
        }),
      ),
    );
  });
});
// SCIENT-FORK:END scient-window-ipc

// SCIENT-FORK:START restored-sole-guards - upstream's snap dropped these; mutating the guarded checks left every other desktop test green.
describe("pasteAsText", () => {
  // regression: 68c2277f50 feat(composer): fold large pastes into text attachments (#11442) - sole guard of the sender-ID check
  it.effect(
    "pastes into the focused guest only after the main renderer acknowledges the menu action",
    () => {
      const paste = vi.fn();
      const mainPaste = vi.fn();
      const window = {
        webContents: { id: 42, paste: mainPaste },
        isDestroyed: () => false,
      } as unknown as Electron.BrowserWindow;
      focusedWebContents.mockReturnValue({ paste, isDestroyed: () => false });
      ownerWindow.mockReturnValue(window);

      return Effect.gen(function* () {
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        assert.equal(mainPaste.mock.calls.length, 0);

        yield* pasteAsText.handler(undefined, { sender: { id: 99 } });
        assert.equal(paste.mock.calls.length, 1);
        ownerWindow.mockReturnValue({}); // A focused PiP/other BrowserWindow.
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        ownerWindow.mockReturnValue(null); // Detached contents.
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        ownerWindow.mockReturnValue(window);
        focusedWebContents.mockReturnValue({ paste, isDestroyed: () => true });
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
        focusedWebContents.mockReturnValue(null);
        yield* pasteAsText.handler(undefined, { sender: { id: 42 } });
        assert.equal(paste.mock.calls.length, 1);
      }).pipe(
        Effect.provide(
          Layer.mock(ElectronWindow.ElectronWindow)({
            main: Effect.succeedSome(window),
          }),
        ),
      );
    },
  );
});

describe("pickProjectFavicon", () => {
  const pickerLayer = (
    pickFiles: () => Effect.Effect<Array<string>>,
    settings?: DesktopAppSettings.DesktopSettings,
  ) =>
    Layer.mergeAll(
      Layer.mock(ElectronDialog.ElectronDialog)({ pickFiles }),
      Layer.mock(ElectronWindow.ElectronWindow)({
        focusedMainOrFirst: Effect.succeedNone,
      }),
      DesktopAppSettings.layerTest(settings),
    );

  // regression: 44e4a7071d feat(desktop): choose external project icons (#7823) - sole guard of the picker options
  it.effect("opens a single-image picker from the project directory", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon
        .handler("/project")
        .pipe(Effect.provide(pickerLayer(pickFiles)));

      assert.strictEqual(result, "/pictures/icon.png");
      assert.deepEqual(pickFiles.mock.calls, [
        [
          {
            owner: Option.none(),
            defaultPath: Option.some("/project"),
            multiple: false,
            filters: [
              {
                name: "Images",
                extensions: ["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp", "icns"],
              },
            ],
          },
        ],
      ]);
    }),
  );

  // regression: cba7dd7781 feat(desktop): allow disabling the local environment (#9194) - sole guard of the disabled-environment check
  it.effect("does not open a picker while the local environment is off", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon.handler("/project").pipe(
        Effect.provide(
          pickerLayer(pickFiles, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
          }),
        ),
      );

      assert.strictEqual(result, null);
      assert.strictEqual(pickFiles.mock.calls.length, 0);
    }),
  );
});
// SCIENT-FORK:END restored-sole-guards
