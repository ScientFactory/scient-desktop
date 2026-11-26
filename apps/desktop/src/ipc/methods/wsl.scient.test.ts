import * as NodeServices from "@effect/platform-node/NodeServices";
import { DesktopWslStateSchema } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopManagedPolicy from "../../app/DesktopManagedPolicy.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopWslBackend from "../../wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "../../wsl/DesktopWslEnvironment.ts";
import { getWslState, setWslBackendEnabled, setWslDistro, setWslOnly } from "./wsl.ts";

const decodeWslState = Schema.decodeUnknownEffect(DesktopWslStateSchema);

const layerUnusedLifecycleRuntime = Layer.mergeAll(
  DesktopShutdown.layer,
  DesktopState.layer,
  Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of(
      {} as DesktopEnvironment.DesktopEnvironment["Service"],
    ),
  ),
  Layer.succeed(
    DesktopWindow.DesktopWindow,
    DesktopWindow.DesktopWindow.of({} as DesktopWindow.DesktopWindow["Service"]),
  ),
  Layer.succeed(
    ElectronApp.ElectronApp,
    ElectronApp.ElectronApp.of({} as ElectronApp.ElectronApp["Service"]),
  ),
  Layer.succeed(
    ElectronTheme.ElectronTheme,
    ElectronTheme.ElectronTheme.of({} as ElectronTheme.ElectronTheme["Service"]),
  ),
  Layer.succeed(
    ElectronDialog.ElectronDialog,
    ElectronDialog.ElectronDialog.of({} as ElectronDialog.ElectronDialog["Service"]),
  ),
  Layer.succeed(
    ElectronWindow.ElectronWindow,
    ElectronWindow.ElectronWindow.of({} as ElectronWindow.ElectronWindow["Service"]),
  ),
  DesktopClientSettings.layerTest(),
);

describe("WSL package capability in slim Windows builds", () => {
  it.effect(
    "returns false without spawning reg.exe when packaged with scientWslRuntimeOmitted",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-wsl-slim-" });
        const windir = path.join(tempDir, "Windows");
        yield* fileSystem.makeDirectory(path.join(windir, "System32"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(windir, "System32", "wsl.exe"), "");

        const appRoot = path.join(tempDir, "app");
        yield* fileSystem.makeDirectory(appRoot, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(appRoot, "package.json"),
          JSON.stringify({ name: "scient-next", scientWslRuntimeOmitted: true }),
        );

        let spawnCount = 0;
        const spawner = ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            spawnCount += 1;
          }).pipe(
            Effect.as({
              exitCode: Effect.succeed(0 as unknown as ChildProcessSpawner.ExitCode),
            } as unknown as ChildProcessSpawner.ChildProcessHandle),
          ),
        );
        const layer = Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(
            DesktopManagedPolicy.DesktopManagedPolicy,
            DesktopManagedPolicy.DesktopManagedPolicy.of({
              read: Effect.undefined,
            }),
          ),
        );

        // Slim packaged build: explicit metadata -> unavailable with zero subprocess probes.
        const slimAvailable = yield* DesktopWslEnvironment.makeIsAvailable("win32", windir, {
          isPackaged: true,
          appRoot,
        }).pipe(Effect.provide(layer));
        assert.isFalse(slimAvailable);
        assert.equal(spawnCount, 0);

        // Unpackaged dev build still checks host availability even if appRoot metadata is set.
        const devAvailable = yield* DesktopWslEnvironment.makeIsAvailable("win32", windir, {
          isPackaged: false,
          appRoot,
        }).pipe(Effect.provide(layer));
        assert.isTrue(devAvailable);
        assert.isAbove(spawnCount, 0);

        // Packaged build without scientWslRuntimeOmitted (full or mounted-only WSL) probes host normally.
        yield* fileSystem.writeFileString(
          path.join(appRoot, "package.json"),
          JSON.stringify({ name: "scient-next" }),
        );
        const fullAvailable = yield* DesktopWslEnvironment.makeIsAvailable("win32", windir, {
          isPackaged: true,
          appRoot,
        }).pipe(Effect.provide(layer));
        assert.isTrue(fullAvailable);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "keeps saved WSL preferences while WSL is unavailable until the user turns WSL off, without relaunching",
    () =>
      Effect.gen(function* () {
        const relaunchReasons: Array<string> = [];
        let reconcileCount = 0;
        const layer = Layer.mergeAll(
          layerUnusedLifecycleRuntime,
          DesktopAppSettings.layerTest({
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: true,
            wslBackendEnabled: true,
            wslOnly: true,
            wslDistro: "Ubuntu",
          }),
          DesktopWslEnvironment.layerTest({ isAvailable: false }),
          Layer.succeed(
            DesktopWslBackend.DesktopWslBackend,
            DesktopWslBackend.DesktopWslBackend.of({
              reconcile: Effect.sync(() => {
                reconcileCount += 1;
              }),
              lastPreflightError: Effect.succeedNone,
            }),
          ),
          Layer.succeed(
            DesktopLifecycle.DesktopLifecycle,
            DesktopLifecycle.DesktopLifecycle.of({
              relaunch: (reason) =>
                Effect.sync(() => {
                  relaunchReasons.push(reason);
                }),
              register: Effect.void,
            }),
          ),
        );

        yield* Effect.gen(function* () {
          const initial = yield* getWslState
            .handler(undefined)
            .pipe(Effect.flatMap(decodeWslState));
          assert.isFalse(initial.available);
          assert.deepEqual(initial.distros, []);
          assert.isTrue(initial.enabled);
          assert.isTrue(initial.wslOnly);
          assert.equal(initial.distro, "Ubuntu");

          const afterDistro = yield* setWslDistro
            .handler("Debian")
            .pipe(Effect.flatMap(decodeWslState));
          assert.equal(afterDistro.distro, "Ubuntu");

          // Settings' "Switch to Windows" on the unavailable WSL row.
          const afterDisable = yield* setWslBackendEnabled
            .handler(false)
            .pipe(Effect.flatMap(decodeWslState));
          assert.isFalse(afterDisable.enabled);
          assert.isFalse(afterDisable.wslOnly);

          yield* setWslBackendEnabled.handler(true);
          const afterReenable = yield* setWslOnly
            .handler(true)
            .pipe(Effect.flatMap(decodeWslState));
          assert.isFalse(afterReenable.enabled);
          assert.isFalse(afterReenable.wslOnly);
        }).pipe(Effect.provide(layer));

        assert.deepEqual(relaunchReasons, []);
        assert.equal(reconcileCount, 0);
      }),
  );

  it.effect("clears a staged WSL-only preference while WSL is unavailable", () =>
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        layerUnusedLifecycleRuntime,
        DesktopAppSettings.layerTest({
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          localEnvironmentEnabled: true,
          wslBackendEnabled: false,
          wslOnly: true,
        }),
        DesktopWslEnvironment.layerTest({ isAvailable: false }),
        Layer.succeed(
          DesktopWslBackend.DesktopWslBackend,
          DesktopWslBackend.DesktopWslBackend.of({
            reconcile: Effect.void,
            lastPreflightError: Effect.succeedNone,
          }),
        ),
        Layer.succeed(
          DesktopLifecycle.DesktopLifecycle,
          DesktopLifecycle.DesktopLifecycle.of({
            relaunch: () => Effect.die("unexpected relaunch"),
            register: Effect.void,
          }),
        ),
      );

      const state = yield* setWslOnly
        .handler(false)
        .pipe(Effect.flatMap(decodeWslState), Effect.provide(layer));
      assert.isFalse(state.wslOnly);
    }),
  );
});
