import * as NodeServices from "@effect/platform-node/NodeServices";
import { DesktopWslStateSchema } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopManagedPolicy from "../../app/DesktopManagedPolicy.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWslBackend from "../../wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "../../wsl/DesktopWslEnvironment.ts";
import { getWslState, setWslBackendEnabled, setWslDistro, setWslOnly } from "./wsl.ts";

const decodeWslState = Schema.decodeUnknownEffect(DesktopWslStateSchema);

describe("WSL package capability in slim Windows builds", () => {
  it.effect("returns false without spawning reg.exe when packaged without wsl-runtime.tar.gz", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-wsl-slim-" });
      const windir = path.join(tempDir, "Windows");
      yield* fileSystem.makeDirectory(path.join(windir, "System32"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(windir, "System32", "wsl.exe"), "");

      const resourcesPath = path.join(tempDir, "resources");
      yield* fileSystem.makeDirectory(resourcesPath, { recursive: true });

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
            read: Effect.succeed(undefined),
          }),
        ),
      );

      // Slim packaged build: archive missing -> unavailable with zero subprocess probes.
      const slimAvailable = yield* DesktopWslEnvironment.makeIsAvailable("win32", windir, {
        isPackaged: true,
        resourcesPath,
      }).pipe(Effect.provide(layer));
      assert.isFalse(slimAvailable);
      assert.equal(spawnCount, 0);

      // Fail closed when packaged resourcesPath is missing.
      const missingPathAvailable = yield* DesktopWslEnvironment.makeIsAvailable("win32", windir, {
        isPackaged: true,
      }).pipe(Effect.provide(layer));
      assert.isFalse(missingPathAvailable);
      assert.equal(spawnCount, 0);

      // Unpackaged dev build still checks host availability without the archive.
      const devAvailable = yield* DesktopWslEnvironment.makeIsAvailable("win32", windir, {
        isPackaged: false,
        resourcesPath,
      }).pipe(Effect.provide(layer));
      assert.isTrue(devAvailable);
      assert.isAbove(spawnCount, 0);

      // Packaged build with the archive shipped is available on a WSL host.
      yield* fileSystem.writeFileString(path.join(resourcesPath, "wsl-runtime.tar.gz"), "");
      const fullAvailable = yield* DesktopWslEnvironment.makeIsAvailable("win32", windir, {
        isPackaged: true,
        resourcesPath,
      }).pipe(Effect.provide(layer));
      assert.isTrue(fullAvailable);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("preserves saved WSL preferences and never relaunches when WSL is unavailable", () =>
    Effect.gen(function* () {
      const relaunchReasons: Array<string> = [];
      let reconcileCount = 0;
      const layer = Layer.mergeAll(
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

      const initial = yield* getWslState
        .handler(undefined)
        .pipe(Effect.flatMap(decodeWslState), Effect.provide(layer));
      assert.isFalse(initial.available);
      assert.deepEqual(initial.distros, []);
      assert.isTrue(initial.enabled);
      assert.isTrue(initial.wslOnly);
      assert.equal(initial.distro, "Ubuntu");

      const afterEnable = yield* setWslBackendEnabled
        .handler(false)
        .pipe(Effect.flatMap(decodeWslState), Effect.provide(layer));
      const afterOnly = yield* setWslOnly
        .handler(false)
        .pipe(Effect.flatMap(decodeWslState), Effect.provide(layer));
      const afterDistro = yield* setWslDistro
        .handler("Debian")
        .pipe(Effect.flatMap(decodeWslState), Effect.provide(layer));

      assert.isTrue(afterEnable.enabled);
      assert.isTrue(afterOnly.wslOnly);
      assert.equal(afterDistro.distro, "Ubuntu");
      assert.deepEqual(relaunchReasons, []);
      assert.equal(reconcileCount, 0);
    }),
  );
});
