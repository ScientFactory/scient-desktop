import * as NodeServices from "@effect/platform-node/NodeServices";
import { DesktopWslStateSchema } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWslBackend from "../../wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "../../wsl/DesktopWslEnvironment.ts";
import { getWslState } from "./wsl.ts";

const decodeWslState = Schema.decodeUnknownEffect(DesktopWslStateSchema);

/** WSL availability for an installed app whose resources folder holds `files`. */
const availableWith = (files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resourcesPath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-wsl-" });
    for (const file of files) yield* fileSystem.writeFileString(path.join(resourcesPath, file), "");
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        localEnvironmentEnabled: true,
      }),
      DesktopWslEnvironment.layerTest({ isAvailable: true }),
      Layer.succeed(
        DesktopWslBackend.DesktopWslBackend,
        DesktopWslBackend.DesktopWslBackend.of({
          reconcile: Effect.void,
          lastPreflightError: Effect.succeedNone,
        }),
      ),
      Layer.succeed(
        DesktopEnvironment.DesktopEnvironment,
        DesktopEnvironment.DesktopEnvironment.of({
          isPackaged: true,
          resourcesPath,
          path,
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
      ),
    );
    const state = yield* getWslState
      .handler(undefined)
      .pipe(Effect.flatMap(decodeWslState), Effect.provide(layer));
    return state.available;
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("WSL availability in an installed app", () => {
  it.effect("offers WSL only when the installer shipped the WSL runtime archive", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* availableWith(["wsl-runtime.tar.gz"]));
      assert.isFalse(yield* availableWith([]));
    }),
  );
});
